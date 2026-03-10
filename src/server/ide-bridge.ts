import * as vscode from 'vscode';
import { sseManager } from './sse';
import { addActivity } from './activity';
import { markFileEdited } from './edit-state';

/**
 * Bridges VS Code events to SSE broadcasts so the mobile dashboard
 * receives real-time updates about IDE state changes.
 */
export function initIDEBridge(context: vscode.ExtensionContext) {
    const subs = context.subscriptions;

    // --- Initial activity entries ---
    const ws = vscode.workspace.workspaceFolders?.[0]?.name ?? 'unknown';
    addActivity('info', `Remote Control connected to workspace: ${ws}`);
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        addActivity('info', `Active file: ${shortP(editor.document.uri.fsPath)} (${editor.document.languageId})`);
    }
    const diagSummary = getDiagnosticsSummary();
    if (diagSummary.errors > 0 || diagSummary.warnings > 0) {
        addActivity('error', `${diagSummary.errors} error(s), ${diagSummary.warnings} warning(s) in workspace`);
    }
    const termCount = vscode.window.terminals.length;
    if (termCount > 0) {
        addActivity('info', `${termCount} terminal(s) open`);
    }
    const tabCount = vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
    addActivity('info', `${tabCount} editor tab(s) open`);

    // --- Active editor changed ---
    subs.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        const file = editor?.document.uri.fsPath ?? null;
        sseManager.broadcast('ide-active-editor', {
            file,
            languageId: editor?.document.languageId ?? null,
            lineCount: editor?.document.lineCount ?? null,
        });
        if (file) { addActivity('info', `Opened ${shortP(file)}`, file); }
    }));

    // --- Document saved ---
    subs.push(vscode.workspace.onDidSaveTextDocument(doc => {
        sseManager.broadcast('ide-file-saved', {
            file: doc.uri.fsPath,
            languageId: doc.languageId,
        });
        markFileEdited();
        addActivity('file-save', `Saved ${shortP(doc.uri.fsPath)}`);
    }));

    // --- Document changed (debounced) ---
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    subs.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme !== 'file') { return; }
        if (editTimer) { clearTimeout(editTimer); }
        editTimer = setTimeout(() => {
            sseManager.broadcast('ide-file-changed', {
                file: e.document.uri.fsPath,
                dirty: e.document.isDirty,
                lineCount: e.document.lineCount,
            });
            markFileEdited();
            addActivity('file-edit', `Edited ${shortP(e.document.uri.fsPath)}`);
        }, 500); // debounce 500ms to avoid flooding
    }));

    // --- Diagnostics (errors/warnings) changed ---
    subs.push(vscode.languages.onDidChangeDiagnostics(e => {
        const summary = getDiagnosticsSummary();
        sseManager.broadcast('ide-diagnostics', summary);
        if (summary.errors > 0) {
            addActivity('error', `${summary.errors} error(s), ${summary.warnings} warning(s)`);
        }
    }));

    // --- Terminal opened / closed / changed ---
    subs.push(vscode.window.onDidOpenTerminal(t => {
        sseManager.broadcast('ide-terminal-change', {
            event: 'opened',
            name: t.name,
            terminals: getTerminalList(),
        });
    }));

    subs.push(vscode.window.onDidCloseTerminal(t => {
        sseManager.broadcast('ide-terminal-change', {
            event: 'closed',
            name: t.name,
            terminals: getTerminalList(),
        });
    }));

    subs.push(vscode.window.onDidChangeActiveTerminal(t => {
        sseManager.broadcast('ide-terminal-change', {
            event: 'activated',
            name: t?.name ?? null,
            terminals: getTerminalList(),
        });
    }));

    // --- Selection / cursor changed (debounced) ---
    let selTimer: ReturnType<typeof setTimeout> | null = null;
    subs.push(vscode.window.onDidChangeTextEditorSelection(e => {
        if (selTimer) { clearTimeout(selTimer); }
        selTimer = setTimeout(() => {
            const sel = e.selections[0];
            sseManager.broadcast('ide-cursor', {
                file: e.textEditor.document.uri.fsPath,
                line: sel.active.line + 1,
                column: sel.active.character + 1,
                selectedText: e.textEditor.document.getText(sel).substring(0, 200),
            });
        }, 300);
    }));

    // --- Window focus ---
    subs.push(vscode.window.onDidChangeWindowState(state => {
        sseManager.broadcast('ide-window-state', { focused: state.focused });
    }));

    // --- Periodic full snapshot (every 5s) for SSE clients that just connected ---
    const snapshotInterval = setInterval(() => {
        if (sseManager.clientCount === 0) { return; }
        sseManager.broadcast('ide-snapshot', getIDESnapshot());
    }, 5000);

    subs.push({ dispose: () => clearInterval(snapshotInterval) });
}

function shortP(fp: string): string {
    const parts = fp.replace(/\\/g, '/').split('/');
    return parts.slice(-2).join('/');
}

/** Get a full snapshot of current IDE state */
export function getIDESnapshot() {
    const editor = vscode.window.activeTextEditor;
    return {
        activeFile: editor?.document.uri.fsPath ?? null,
        languageId: editor?.document.languageId ?? null,
        line: editor ? editor.selection.active.line + 1 : null,
        dirty: editor?.document.isDirty ?? false,
        openEditors: vscode.window.tabGroups.all.flatMap(g =>
            g.tabs.map(t => ({
                label: t.label,
                isActive: t.isActive,
            }))
        ),
        terminals: getTerminalList(),
        diagnostics: getDiagnosticsSummary(),
        workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.name ?? null,
    };
}

function getTerminalList() {
    return vscode.window.terminals.map((t, i) => ({
        index: i,
        name: t.name,
        isActive: vscode.window.activeTerminal === t,
    }));
}

function getDiagnosticsSummary() {
    const all = vscode.languages.getDiagnostics();
    let errors = 0;
    let warnings = 0;
    const files: { file: string; errors: number; warnings: number }[] = [];

    for (const [uri, diagnostics] of all) {
        if (uri.scheme !== 'file') { continue; }
        let fe = 0, fw = 0;
        for (const d of diagnostics) {
            if (d.severity === vscode.DiagnosticSeverity.Error) { fe++; errors++; }
            if (d.severity === vscode.DiagnosticSeverity.Warning) { fw++; warnings++; }
        }
        if (fe > 0 || fw > 0) {
            files.push({ file: uri.fsPath, errors: fe, warnings: fw });
        }
    }

    return { errors, warnings, files: files.slice(0, 20) }; // cap at 20 files
}
