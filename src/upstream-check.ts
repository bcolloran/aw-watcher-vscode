// Tells the user when the upstream extension has commits this fork does not have yet.
//
// The packaging step records the upstream commit this build is based on in out/upstream-base.json. Once a day this asks GitHub's public compare API how far upstream's default branch has moved past that commit, and shows a notification while it has. Only a GET to api.github.com is made; nothing from the response is executed.
import { ExtensionContext, Uri, commands, window } from 'vscode';
import { get } from 'https';
import { readFileSync } from 'fs';
import { join } from 'path';

const UPSTREAM_REPO = 'ActivityWatch/aw-watcher-vscode';
const UPSTREAM_BRANCH = 'master';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
// Shared by every VS Code window, so a check in one window covers them all
const NEXT_CHECK_KEY = 'upstreamCheck.nextCheckTime';

interface CompareResult {
    status: string;
    ahead_by: number;
    html_url: string;
    commits: { commit: { message: string } }[];
}

export class UpstreamCheck {
    private _timers: ReturnType<typeof setTimeout>[] = [];

    constructor(private _context: ExtensionContext) {}

    public start() {
        // The poll is hourly so long-running windows still notice the daily deadline; the deadline itself lives in globalState
        this._timers.push(setTimeout(() => this._checkIfDue(), STARTUP_DELAY_MS));
        this._timers.push(setInterval(() => this._checkIfDue(), POLL_MS));
    }

    public dispose() {
        this._timers.forEach(t => clearTimeout(t));
        this._timers = [];
    }

    private async _checkIfDue() {
        const nextCheck = this._context.globalState.get<number>(NEXT_CHECK_KEY, 0);
        if (Date.now() < nextCheck) {
            return;
        }
        const base = this._readUpstreamBase();
        if (!base) {
            console.warn('[ActivityWatch] No out/upstream-base.json in this build; skipping the upstream check. Package with `npm run package` to record it.');
            return;
        }
        let result: CompareResult;
        try {
            result = await this._compare(base);
        } catch (err) {
            // Offline or rate-limited: try again at the next hourly poll
            console.warn('[ActivityWatch] Upstream check failed:', err);
            return;
        }
        await this._context.globalState.update(NEXT_CHECK_KEY, Date.now() + CHECK_INTERVAL_MS);
        if (result.ahead_by > 0) {
            this._notify(result);
        }
    }

    private _readUpstreamBase(): string | undefined {
        try {
            const file = join(this._context.extensionPath, 'out', 'upstream-base.json');
            const sha = JSON.parse(readFileSync(file, 'utf8')).upstreamBase;
            return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
        } catch {
            return undefined;
        }
    }

    private _compare(base: string): Promise<CompareResult> {
        return new Promise((resolve, reject) => {
            const request = get({
                hostname: 'api.github.com',
                path: `/repos/${UPSTREAM_REPO}/compare/${base}...${UPSTREAM_BRANCH}`,
                headers: { 'User-Agent': 'aw-watcher-vscode-fork', Accept: 'application/vnd.github+json' }
            }, response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => body += chunk);
                response.on('end', () => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`GitHub answered HTTP ${response.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            request.setTimeout(REQUEST_TIMEOUT_MS, () => {
                request.abort();
                reject(new Error('request timed out'));
            });
            request.on('error', reject);
        });
    }

    private async _notify(result: CompareResult) {
        const latest = result.commits.length > 0 ? result.commits[result.commits.length - 1].commit.message.split('\n')[0].slice(0, 100) : '';
        const viewChanges = 'View upstream changes';
        const updateSteps = 'How to update';
        const snooze = 'Remind me in a week';
        const choice = await window.showWarningMessage(
            `[ActivityWatch] Your aw-watcher-vscode fork is ${result.ahead_by} upstream commit(s) behind. Latest: "${latest}"`,
            viewChanges, updateSteps, snooze
        );
        if (choice === viewChanges && result.html_url.startsWith('https://github.com/')) {
            commands.executeCommand('vscode.open', Uri.parse(result.html_url));
        } else if (choice === updateSteps) {
            commands.executeCommand('markdown.showPreview', Uri.file(join(this._context.extensionPath, 'README.md')));
        } else if (choice === snooze) {
            await this._context.globalState.update(NEXT_CHECK_KEY, Date.now() + SNOOZE_MS);
        }
    }
}
