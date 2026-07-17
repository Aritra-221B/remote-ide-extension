const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function bundle() {
    await esbuild.build({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        target: ['node18'],
        external: ['vscode'],
        sourcemap: false,
        minify: false,
    });

    const srcDashboard = path.join('src', 'dashboard');
    const distDashboard = path.join('dist', 'dashboard');
    fs.mkdirSync(distDashboard, { recursive: true });
    fs.cpSync(srcDashboard, distDashboard, { recursive: true });
}

bundle().catch((error) => {
    console.error(error);
    process.exit(1);
});
