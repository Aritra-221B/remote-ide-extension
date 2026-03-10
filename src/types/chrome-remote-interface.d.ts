declare module 'chrome-remote-interface' {
    interface CDPOptions {
        target?: any;
        port?: number;
    }

    interface CDPClient {
        Runtime: {
            enable(): Promise<void>;
            evaluate(params: { expression: string; returnByValue: boolean }): Promise<{ result: { value: any } }>;
        };
        DOM: {
            enable(): Promise<void>;
        };
        Page: {
            enable(): Promise<void>;
            captureScreenshot(params: { format: string; quality: number }): Promise<{ data: string }>;
        };
        close(): Promise<void>;
    }

    function CDP(options?: CDPOptions): Promise<CDPClient>;

    namespace CDP {
        function List(options?: { port?: number }): Promise<Array<{ type: string; url: string }>>;
    }

    export = CDP;
}
