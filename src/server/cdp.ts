import CDP from 'chrome-remote-interface';

export class CDPClient {
    private client: any = null;

    async connect(port: number = 9222) {
        try {
            const targets = await CDP.List({ port });
            const target = targets.find(
                (t: any) => t.type === 'page' && t.url.includes('workbench')
            );
            if (!target) { throw new Error('No workbench target found'); }

            this.client = await CDP({ target, port });
            await this.client.Runtime.enable();
            await this.client.DOM.enable();
            return true;
        } catch (err) {
            console.error('CDP connection failed:', err);
            return false;
        }
    }

    get isConnected() {
        return this.client !== null;
    }

    async getChatHTML(): Promise<string> {
        if (!this.client) { return '<p>CDP not connected</p>'; }
        try {
            const result = await this.client.Runtime.evaluate({
                expression: `
                    (() => {
                        const chat = document.querySelector('.chat-widget')
                            || document.querySelector('[class*="chat"]');
                        return chat ? chat.innerHTML : '<p>No chat found</p>';
                    })()
                `,
                returnByValue: true
            });
            return result.result.value || '';
        } catch (err) {
            return `<p>Error reading chat: ${err}</p>`;
        }
    }

    async takeScreenshot(): Promise<string> {
        if (!this.client) { return ''; }
        await this.client.Page.enable();
        const { data } = await this.client.Page.captureScreenshot({
            format: 'jpeg',
            quality: 60
        });
        return data;
    }

    async sendPrompt(text: string): Promise<boolean> {
        if (!this.client) { return false; }
        try {
            const result = await this.client.Runtime.evaluate({
                expression: `
                    (() => {
                        const input = document.querySelector('textarea[class*="chat"]')
                            || document.querySelector('.chat-input textarea');
                        if (!input) return false;
                        const nativeSet = Object.getOwnPropertyDescriptor(
                            window.HTMLTextAreaElement.prototype, 'value'
                        )?.set;
                        if (nativeSet) nativeSet.call(input, ${JSON.stringify(text)});
                        else input.value = ${JSON.stringify(text)};
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        const btn = document.querySelector('button[class*="send"]');
                        if (btn) btn.click();
                        return true;
                    })()
                `,
                returnByValue: true
            });
            return result.result.value === true;
        } catch {
            return false;
        }
    }

    async clickAction(action: 'accept' | 'reject'): Promise<boolean> {
        if (!this.client) { return false; }
        // VS Code shows "Keep" / "Undo" (2025+) or "Accept" / "Discard" (older)
        const labels = action === 'accept'
            ? ['Keep', 'Accept']
            : ['Undo', 'Discard', 'Reject'];
        try {
            const result = await this.client.Runtime.evaluate({
                expression: `
                    (() => {
                        const labels = ${JSON.stringify(labels)};
                        const buttons = document.querySelectorAll('button, [role="button"], .monaco-button');
                        for (const btn of buttons) {
                            const text = (btn.textContent || '').trim();
                            const title = (btn.getAttribute('title') || '').trim();
                            const aria = (btn.getAttribute('aria-label') || '').trim();
                            for (const label of labels) {
                                if (text === label || title.includes(label) || aria.includes(label)) {
                                    btn.click();
                                    return true;
                                }
                            }
                        }
                        return false;
                    })()
                `,
                returnByValue: true
            });
            return result.result.value === true;
        } catch {
            return false;
        }
    }

    async disconnect() {
        await this.client?.close();
        this.client = null;
    }
}
