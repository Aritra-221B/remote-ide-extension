# Contributing

Thank you for your interest in contributing to Remote IDE Extension!

## Getting Started

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Press F5 in VS Code to launch the Extension Development Host

## Development Workflow

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Run tests: `node test/smoke.js`
4. Build: `npm run build`
5. Test in the Extension Development Host (F5)
6. Commit with clear messages
7. Push and open a Pull Request

## Code Style

- TypeScript strict mode is enabled
- Use `const` / `let` over `var`
- Prefer async/await over raw Promises
- Keep functions focused and small

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- VS Code version and OS

## Pull Requests

- Keep PRs focused on a single change
- Include tests for new features
- Update the README if adding user-facing features
- Ensure `npm run build` produces zero errors
