import { sseManager } from './sse';

export interface ActivityEntry {
    id: number;
    time: number;
    type: 'prompt' | 'action' | 'file-edit' | 'file-save' | 'error' | 'info' | 'terminal';
    text: string;
    detail?: string;
}

const MAX_ENTRIES = 200;
const entries: ActivityEntry[] = [];
let nextId = 1;

export function addActivity(type: ActivityEntry['type'], text: string, detail?: string) {
    const entry: ActivityEntry = { id: nextId++, time: Date.now(), type, text, detail };
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) { entries.shift(); }
    sseManager.broadcast('activity', entry);
}

export function getRecentActivity(limit = 50): ActivityEntry[] {
    return entries.slice(-limit);
}
