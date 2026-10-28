// The module 'vscode' contains the VS Code extensibility API
// Import the necessary extensibility types to use in your code below
import { Disposable, ExtensionContext, commands, window, workspace, Uri, Extension, extensions } from 'vscode';
import { AWClient, IAppEditorEvent } from '../aw-client-js/src/aw-client';
import { hostname } from 'os';
import { API, GitExtension } from './git';
import { UpstreamCheck } from './upstream-check';

// The upstream extension's id. This fork publishes under its own id, so having both installed means two watchers reporting the same time.
const UPSTREAM_EXTENSION_ID = 'activitywatch.aw-watcher-vscode';

// This method is called when your extension is activated. Activation is
// controlled by the activation events defined in package.json.
export function activate(context: ExtensionContext) {
    console.log('Congratulations, your extension "ActivityWatch" is now active!');

    // Init ActivityWatch
    const controller = new ActivityWatch();
    controller.init();
    context.subscriptions.push(controller);

    // Command:Reload
    const reloadCommand = commands.registerCommand('awWatcherVscodeFork.reload', () => controller.init());
    context.subscriptions.push(reloadCommand);

    const upstreamCheck = new UpstreamCheck(context);
    upstreamCheck.start();
    context.subscriptions.push(upstreamCheck);

    warnIfUpstreamInstalled();
}

function warnIfUpstreamInstalled() {
    if (!extensions.getExtension(UPSTREAM_EXTENSION_ID)) {
        return;
    }
    const show = 'Show it';
    window.showWarningMessage(
        `[ActivityWatch] The Marketplace extension ${UPSTREAM_EXTENSION_ID} is installed alongside your fork, so VS Code time is counted twice. Uninstall the Marketplace one.`,
        show
    ).then(choice => {
        if (choice === show) {
            commands.executeCommand('workbench.extensions.search', `@installed ${UPSTREAM_EXTENSION_ID}`);
        }
    });
}

class ActivityWatch {
    private _disposable: Disposable;
    private _client: AWClient;
    private _git: API | undefined;

    // Bucket info
    private _bucket: {
        id: string;
        hostName: string;
        clientName: string;
        eventType: string;
    };
    private _bucketCreated: boolean = false;

    // Heartbeat handling
    private _pulseTime: number = 20;
    private _maxHeartbeatsPerSec: number = 1;
    private _lastFilePath: string = '';
    private _lastHeartbeatTime: number = 0; // Date.getTime()
    private _lastBranch: string = '';

    // Periodic heartbeats while the window is focused, so time spent in webviews, terminals and other non-text views is recorded too
    private _focusedHeartbeatIntervalSec: number = 10;
    private _focusedHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

    constructor() {
        this._bucket = {
            id: '',
            hostName: hostname(),
            clientName: 'aw-watcher-vscode',
            eventType: 'app.editor.activity'
        };
        this._bucket.id = `${this._bucket.clientName}_${this._bucket.hostName}`;

        // Create AWClient
        this._client = new AWClient(this._bucket.clientName, { testing: false });

        // subscribe to VS Code Events
        let subscriptions: Disposable[] = [];
        window.onDidChangeTextEditorSelection(this._onEvent, this, subscriptions);
        window.onDidChangeActiveTextEditor(this._onEvent, this, subscriptions);
        window.onDidChangeWindowState(this._onEvent, this, subscriptions);
        this._disposable = Disposable.from(...subscriptions);
    }

    public init() {
        // Create new Bucket (if not existing)
        this._client.ensureBucket(this._bucket.id, this._bucket.eventType, this._bucket.hostName)
            .then((res) => {
                if (res.alreadyExist) {
                    console.log('Bucket already exists');
                } else {
                    console.log('Created Bucket');
                }
                this._bucketCreated = true;
            })
            .catch(err => {
                this._handleError("Couldn't create Bucket. Please make sure the server is running properly and then run the [Reload ActivityWatch] command.", true);
                this._bucketCreated = false;
                console.error(err);
            });
        this.initGit().then((res) => this._git = res);
        this.loadConfigurations();
    }

    private async initGit() {
        const extension = extensions.getExtension('vscode.git') as Extension<GitExtension>;
        const gitExtension = extension.isActive ? extension.exports : await extension.activate();
        return gitExtension.getAPI(1);
    }

    public loadConfigurations() {
        const extConfigurations = workspace.getConfiguration('aw-watcher-vscode');
        const maxHeartbeatsPerSec = extConfigurations.get('maxHeartbeatsPerSec');
        if (maxHeartbeatsPerSec) {
            this._maxHeartbeatsPerSec = maxHeartbeatsPerSec as number;
        }
        const focusedHeartbeatIntervalSec = extConfigurations.get('focusedHeartbeatIntervalSec');
        if (typeof focusedHeartbeatIntervalSec === 'number') {
            this._focusedHeartbeatIntervalSec = focusedHeartbeatIntervalSec;
        }
        this._startFocusedHeartbeatTimer();
    }

    public dispose() {
        this._stopFocusedHeartbeatTimer();
        this._disposable.dispose();
    }

    // Restarts the timer, so reloading the configuration never leaves two running. An interval of 0 or less disables it.
    private _startFocusedHeartbeatTimer() {
        this._stopFocusedHeartbeatTimer();
        if (this._focusedHeartbeatIntervalSec <= 0) {
            return;
        }
        this._focusedHeartbeatTimer = setInterval(() => this._onEvent(), this._focusedHeartbeatIntervalSec * 1000);
    }

    private _stopFocusedHeartbeatTimer() {
        if (this._focusedHeartbeatTimer !== undefined) {
            clearInterval(this._focusedHeartbeatTimer);
            this._focusedHeartbeatTimer = undefined;
        }
    }

    private _onEvent() {
        if (!this._bucketCreated) {
            return;
        }
        // Only the focused window is being worked in; heartbeats from background windows would double-count time
        if (!window.state.focused) {
            return;
        }

        // Create and send heartbeat
        try {
            const heartbeat = this._createHeartbeat();
            const filePath = this._getFilePath();
            const curTime = new Date().getTime();
            const branch = this._getCurrentBranch();

            // Send heartbeat if file changed, branch changed or enough time passed
            if (filePath !== this._lastFilePath ||
                    branch !== this._lastBranch ||
                    this._lastHeartbeatTime + (1000 / (this._maxHeartbeatsPerSec)) < curTime) {
                this._lastFilePath = filePath || 'unknown';
                this._lastHeartbeatTime = curTime;
                this._sendHeartbeat(heartbeat);
            }
        }
        catch (err: any) {
            this._handleError(err);
        }
    }

    private _sendHeartbeat(event: IAppEditorEvent) {
        return this._client.heartbeat(this._bucket.id, this._pulseTime, event)
            .then(() => console.log('Sent heartbeat', event))
            .catch(({ err }) => {
                console.error('sendHeartbeat error: ', err);
                this._handleError('Error while sending heartbeat', true);
            });
    }

    private _createHeartbeat(): IAppEditorEvent {
        return {
            timestamp: new Date(),
            duration: 0,
            data: {
                language: this._getFileLanguage() || 'unknown',
                project: this._getProjectFolder() || 'unknown',
                file: this._getFilePath() || 'unknown',
                branch: this._getCurrentBranch() || 'unknown'
            }
        };
    }

    // The workspace folder of the active file; when no text editor is active, or the file is outside every workspace folder, the window's first workspace folder.
    private _getProjectFolder(): string | undefined {
        const fileUri = this._getActiveFileUri();
        const workspaceFolder = fileUri && workspace.getWorkspaceFolder(fileUri);
        if (workspaceFolder) {
            return workspaceFolder.uri.path;
        }

        return workspace.workspaceFolders?.[0]?.uri.path;
    }

    private _getActiveFileUri(): Uri | undefined {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        return editor.document.uri;
    }

    private _getFilePath(): string | undefined {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        return editor.document.fileName;
    }

    private _getFileLanguage(): string | undefined {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        return editor.document.languageId;
    }

    private _getCurrentBranch(): string | undefined {
        if (this._git === undefined) {
            return;
        }
        return this._git.repositories[0]?.state?.HEAD?.name;
    }

    private _handleError(err: string, isCritical = false): undefined {
        if (isCritical) {
            console.error('[ActivityWatch][handleError]', err);
            window.showErrorMessage(`[ActivityWatch] ${err}`);
        }
        else {
            console.warn('[AcitivtyWatch][handleError]', err);
        }
        return;
    }
}
