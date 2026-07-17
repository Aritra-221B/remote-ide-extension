import CDP from 'chrome-remote-interface';
import { getPlatform } from './platform';
import type { CDPSelectors } from './platform';

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
        } catch (err: any) {
            // Only log if it's NOT a standard connection refused (which is expected if launched normally)
            if (err.code !== 'ECONNREFUSED') {
                console.error('CDP connection failed:', err.message);
            }
            return false;
        }
    }

    get isConnected() {
        return this.client !== null;
    }

    /**
     * Returns the platform-specific CDP selectors.
     * Falls back to safe defaults if platform isn't initialised yet.
     */
    private getSelectors(): CDPSelectors {
        try {
            return getPlatform().getCDPSelectors();
        } catch {
            // Platform not initialised yet — use safe defaults
            return {
                chatContainer: '.chat-widget, [class*="chat"]',
                chatInput: 'textarea[class*="chat"], .chat-input textarea',
                acceptLabels: ['Keep', 'Accept'],
                rejectLabels: ['Undo', 'Discard', 'Reject'],
            };
        }
    }

    async getChatHTML(): Promise<string> {
        if (!this.client) { return '<p>CDP not connected</p>'; }
        const selectors = this.getSelectors();
        try {
            const result = await this.client.Runtime.evaluate({
                expression: `
                    (() => {
                        const chat = document.querySelector(${JSON.stringify(selectors.chatContainer)});
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
        const selectors = this.getSelectors();
        try {
            const result = await this.client.Runtime.evaluate({
                awaitPromise: true,
                expression: `
                    (async () => {
                        const input = document.querySelector(${JSON.stringify(selectors.chatInput)});
                        if (!input) return false;
                        
                        // Try to focus, but proceed even if obscuration prevents it
                        try { input.focus(); } catch (e) {}

                        const nativeSet = Object.getOwnPropertyDescriptor(
                            window.HTMLTextAreaElement.prototype, 'value'
                        )?.set;
                        if (nativeSet) nativeSet.call(input, ${JSON.stringify(text)});
                        else input.value = ${JSON.stringify(text)};
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        
                        const btn = document.querySelector('button[class*="send"], button[aria-label*="Send"], .send-button');
                        if (btn) {
                            btn.click();
                        } else {
                            // If no clear send button, trigger Enter key
                            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                            await new Promise(r => setTimeout(r, 30)); // Delay to satisfy UI debouncing
                            input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                        }
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
        const selectors = this.getSelectors();
        const labels = action === 'accept'
            ? selectors.acceptLabels
            : selectors.rejectLabels;
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
