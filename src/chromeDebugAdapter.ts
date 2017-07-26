/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

import {ChromeDebugAdapter as CoreDebugAdapter, logger, utils as coreUtils, ISourceMapPathOverrides, stoppedEvent} from 'vscode-chrome-debug-core';
import {spawn, ChildProcess, fork, execSync} from 'child_process';
import {Crdp} from 'vscode-chrome-debug-core';
import {DebugProtocol} from 'vscode-debugprotocol';

import {ILaunchRequestArgs, IAttachRequestArgs, ICommonRequestArgs} from './chromeDebugInterfaces';
import * as utils from './utils';

import * as path from 'path';

const DefaultWebSourceMapPathOverrides: ISourceMapPathOverrides = {
    'webpack:///./~/*': '${webRoot}/node_modules/*',
    'webpack:///./*': '${webRoot}/*',
    'webpack:///*': '*',
    'webpack:///src/*': '${webRoot}/*',
    'meteor://💻app/*': '${webRoot}/*'
};

export class ChromeDebugAdapter extends CoreDebugAdapter {
    private static PAGE_PAUSE_MESSAGE = 'Paused in Kode Studio';

    private _chromeProc: ChildProcess;
    private _overlayHelper: utils.DebounceHelper;
    private _chromePID: number;

    public initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilities {
        this._overlayHelper = new utils.DebounceHelper(/*timeoutMs=*/200);
        const capabilities = super.initialize(args);
        capabilities.supportsRestartRequest = true;

        return capabilities;
    }

    public launch(args: ILaunchRequestArgs): Promise<void> {
        return super.launch(args).then(() => {
            logger.log('Using Kha from ' + args.kha + '\n', true);

            let options = {
                from: args.cwd,
                to: path.join(args.cwd, 'build'),
                projectfile: 'khafile.js',
                target: 'debug-html5',
                vr: 'none',
                pch: false,
                intermediate: '',
                graphics: 'direct3d9',
                visualstudio: 'vs2015',
                kha: '',
                haxe: '',
                ogg: '',
                aac: '',
                mp3: '',
                h264: '',
                webm: '',
                wmv: '',
                theora: '',
                kfx: '',
                krafix: '',
                ffmpeg: args.ffmpeg,
                nokrafix: false,
                embedflashassets: false,
                compile: false,
                run: false,
                init: false,
                name: 'Project',
                server: false,
                port: 8080,
                debug: false,
                silent: false,
                watch: false
            };

            return require(path.join(args.kha, 'Tools/khamake/out/main.js')).run(options, {
                info: message => {
                    logger.log(message, true);
                }, error: message => {
                    logger.error(message, true);
                }
            }).then((value: string) => {
                // Use vscode's electron
                const chromePath = args.runtimeExecutable;
                let chromeDir = chromePath;
                if (chromePath.lastIndexOf('/') >= 0) {
                    chromeDir = chromePath.substring(0, chromePath.lastIndexOf('/'));
                } else if (chromePath.lastIndexOf('\\') >= 0) {
                    chromeDir = chromePath.substring(0, chromePath.lastIndexOf('\\'));
                }

                // Use custom electron
                // const chromeDir = path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist');
                // let chromePath = chromeDir;
                // if (process.platform === 'win32') chromePath = path.join(chromePath, 'electron.exe');
                // else if (process.platform === 'darwin') chromePath = path.join(chromePath, 'Electron.app', 'Contents', 'MacOS', 'Electron');
                // else chromePath = path.join(chromePath, 'electron');

                // Start with remote debugging enabled
                const port = args.port || Math.floor((Math.random() * 10000) + 10000);
                const chromeArgs: string[] = ['--chromedebug', '--remote-debugging-port=' + port];

                chromeArgs.push(path.resolve(args.cwd, args.file));

                let launchUrl: string;
                if (args.file) {
                    launchUrl = coreUtils.pathToFileURL(path.join(args.cwd, args.file, 'index.html'));
                } else if (args.url) {
                    launchUrl = args.url;
                }

                if (launchUrl) {
                    chromeArgs.push(launchUrl);
                }

                logger.log(`spawn('${chromePath}', ${JSON.stringify(chromeArgs) })`);
                this._chromeProc = spawnChrome(chromePath, chromeArgs, !!args.runtimeExecutable);
                this._chromeProc.on('error', (err) => {
                    const errMsg = 'Chrome error: ' + err;
                    logger.error(errMsg);
                    this.terminateSession(errMsg);
                });

                return args.noDebug ? undefined :
                    this.doAttach(port, launchUrl || args.urlFilter, args.address, args.timeout);
            }, (reason) => {
                logger.error('Launch canceled.', true);
                return new Promise<void>((resolve, reject) => {
                    reject({id: Math.floor(Math.random() * 100000), format: 'Compilation failed.'});
                });
            });
        });
    }

    public attach(args: IAttachRequestArgs): Promise<void> {
        if (args.urlFilter) {
            args.url = args.urlFilter;
        }

        return super.attach(args);
    }

    public commonArgs(args: ICommonRequestArgs): void {
        if (!args.webRoot && args.pathMapping && args.pathMapping['/']) {
            // Adapt pathMapping['/'] as the webRoot when not set, since webRoot is explicitly used in many places
            args.webRoot = args.pathMapping['/'];
        }

        args.sourceMaps = typeof args.sourceMaps === 'undefined' || args.sourceMaps;
        args.sourceMapPathOverrides = getSourceMapPathOverrides(args.webRoot, args.sourceMapPathOverrides);
        args.skipFileRegExps = ['^chrome-extension:.*'];

        super.commonArgs(args);
    }

    protected doAttach(port: number, targetUrl?: string, address?: string, timeout?: number): Promise<void> {
        return super.doAttach(port, targetUrl, address, timeout).then(() => {
            // Don't return this promise, a failure shouldn't fail attach
            this.globalEvaluate({ expression: 'navigator.userAgent', silent: true })
                .then(
                    evalResponse => logger.log('Target userAgent: ' + evalResponse.result.value),
                    err => logger.log('Getting userAgent failed: ' + err.message))
                .then(() => {
                    const cacheDisabled = (<ICommonRequestArgs>this._launchAttachArgs).disableNetworkCache || false;
                    this.chrome.Network.setCacheDisabled({ cacheDisabled });
                });
        });
    }

    protected runConnection(): Promise<void>[] {
        return [
            ...super.runConnection(),
            this.chrome.Page.enable(),
            this.chrome.Network.enable({})
        ];
    }

    protected onPaused(notification: Crdp.Debugger.PausedEvent, expectingStopReason?: stoppedEvent.ReasonType): void {
        this._overlayHelper.doAndCancel(() => this.chrome.Page.configureOverlay({ message: ChromeDebugAdapter.PAGE_PAUSE_MESSAGE }).catch(() => { }));
        super.onPaused(notification, expectingStopReason);
    }

    protected threadName(): string {
        return 'Chrome';
    }

    protected onResumed(): void {
        this._overlayHelper.wait(() => this.chrome.Page.configureOverlay({ }).catch(() => { }));
        super.onResumed();
    }

    public disconnect(): void {
        const hadTerminated = this._hasTerminated;

        // Disconnect before killing Chrome, because running "taskkill" when it's paused sometimes doesn't kill it
        super.disconnect();

        if (this._chromeProc && !hadTerminated) {
            // Only kill Chrome if the 'disconnect' originated from vscode. If we previously terminated
            // due to Chrome shutting down, or devtools taking over, don't kill Chrome.
            if (coreUtils.getPlatform() === coreUtils.Platform.Windows && this._chromePID) {
                // Run synchronously because this process may be killed before exec() would run
                const taskkillCmd = `taskkill /F /T /PID ${this._chromePID}`;
                logger.log(`Killing Chrome process by pid: ${taskkillCmd}`);
                try {
                    execSync(taskkillCmd);
                } catch (e) {
                    // Can fail if Chrome was already open, and the process with _chromePID is gone.
                    // Or if it already shut down for some reason.
                }
            } else {
                logger.log('Killing Chrome process');
                this._chromeProc.kill('SIGINT');
            }
        }

        this._chromeProc = null;
    }

    /**
     * Opt-in event called when the 'reload' button in the debug widget is pressed
     */
    public restart(): Promise<void> {
        return this.chrome.Page.reload({ ignoreCache: true });
    }

    private spawnChrome(chromePath: string, chromeArgs: string[], usingRuntimeExecutable: boolean): ChildProcess {
        if (coreUtils.getPlatform() === coreUtils.Platform.Windows && !usingRuntimeExecutable) {
            const chromeProc = fork(getChromeSpawnHelperPath(), [chromePath, ...chromeArgs], { execArgv: [], silent: true });
            chromeProc.unref();

            chromeProc.on('message', data => {
                const pidStr = data.toString();
                logger.log('got chrome PID: ' + pidStr);
                this._chromePID = parseInt(pidStr, 10);
            });

            chromeProc.on('error', (err) => {
                const errMsg = 'chromeSpawnHelper error: ' + err;
                logger.error(errMsg);
            });

            chromeProc.stderr.on('data', data => {
                logger.error('[chromeSpawnHelper] ' + data.toString());
            });

            chromeProc.stdout.on('data', data => {
                logger.log('[chromeSpawnHelper] ' + data.toString());
            });

            return chromeProc;
        } else {
            logger.log(`spawn('${chromePath}', ${JSON.stringify(chromeArgs) })`);
            const chromeProc = spawn(chromePath, chromeArgs, {
                detached: true,
                stdio: ['ignore'],
            });
            chromeProc.unref();
            return chromeProc;
        }
    }
}

function getSourceMapPathOverrides(webRoot: string, sourceMapPathOverrides?: ISourceMapPathOverrides): ISourceMapPathOverrides {
    return sourceMapPathOverrides ? resolveWebRootPattern(webRoot, sourceMapPathOverrides, /*warnOnMissing=*/true) :
            resolveWebRootPattern(webRoot, DefaultWebSourceMapPathOverrides, /*warnOnMissing=*/false);
}

/**
 * Returns a copy of sourceMapPathOverrides with the ${webRoot} pattern resolved in all entries.
 */
export function resolveWebRootPattern(webRoot: string, sourceMapPathOverrides: ISourceMapPathOverrides, warnOnMissing: boolean): ISourceMapPathOverrides {
    const resolvedOverrides: ISourceMapPathOverrides = {};
    for (let pattern in sourceMapPathOverrides) {
        const replacePattern = sourceMapPathOverrides[pattern];
        resolvedOverrides[pattern] = replacePattern;

        const webRootIndex = replacePattern.indexOf('${webRoot}');
        if (webRootIndex === 0) {
            if (webRoot) {
                resolvedOverrides[pattern] = replacePattern.replace('${webRoot}', webRoot);
            } else if (warnOnMissing) {
                logger.log('Warning: sourceMapPathOverrides entry contains ${webRoot}, but webRoot is not set');
            }
        } else if (webRootIndex > 0) {
            logger.log('Warning: in a sourceMapPathOverrides entry, ${webRoot} is only valid at the beginning of the path');
        }
    }

    return resolvedOverrides;
}

function getChromeSpawnHelperPath(): string {
    if (path.basename(__dirname) === 'src') {
        // For tests
        return path.join(__dirname, '../chromeSpawnHelper.js');
    } else {
        return path.join(__dirname, 'chromeSpawnHelper.js');
    }
}
