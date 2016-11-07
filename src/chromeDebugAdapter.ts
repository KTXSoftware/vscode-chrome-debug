/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {ChromeDebugAdapter as CoreDebugAdapter, logger, utils as coreUtils, ISourceMapPathOverrides} from 'vscode-chrome-debug-core';
import {spawn, ChildProcess} from 'child_process';
import Crdp from 'chrome-remote-debug-protocol';
import {DebugProtocol} from 'vscode-debugprotocol';

import {ILaunchRequestArgs, IAttachRequestArgs} from './chromeDebugInterfaces';
import * as utils from './utils';

import * as path from 'path';

const DefaultWebSourceMapPathOverrides: ISourceMapPathOverrides = {
    'webpack:///./*': '${webRoot}/*',
    'webpack:///*': '*',
    'meteor://💻app/*': '${webRoot}/*',
};

export class ChromeDebugAdapter extends CoreDebugAdapter {
    private static PAGE_PAUSE_MESSAGE = 'Paused in Kode Studio';

    private _chromeProc: ChildProcess;
    private _overlayHelper: utils.DebounceHelper;

    public initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilities {
        this._overlayHelper = new utils.DebounceHelper(/*timeoutMs=*/200);
        return super.initialize(args);
    }

    public launch(args: ILaunchRequestArgs): Promise<void> {
        args.sourceMapPathOverrides = getSourceMapPathOverrides(args.webRoot, args.sourceMapPathOverrides);
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
                this._chromeProc = spawn(chromePath, chromeArgs, {
                    detached: true,
                    stdio: ['ignore'],
                    cwd: chromeDir
                });
                this._chromeProc.unref();
                this._chromeProc.on('error', (err) => {
                    const errMsg = 'Chrome error: ' + err;
                    logger.error(errMsg);
                    this.terminateSession(errMsg);
                });

                return this.doAttach(port, launchUrl, args.address);
            }, (reason) => {
                logger.error('Launch canceled.', true);
                return new Promise<void>((resolve) => {

                });
            });
        });
    }

    public attach(args: IAttachRequestArgs): Promise<void> {
        args.sourceMapPathOverrides = getSourceMapPathOverrides(args.webRoot, args.sourceMapPathOverrides);
        return super.attach(args);
    }

    protected doAttach(port: number, targetUrl?: string, address?: string, timeout?: number): Promise<void> {
        return super.doAttach(port, targetUrl, address, timeout).then(() => {
            // Don't return this promise, a failure shouldn't fail attach
            this.globalEvaluate({ expression: 'navigator.userAgent', silent: true })
                .then(
                    evalResponse => logger.log('Target userAgent: ' + evalResponse.result.value),
                    err => logger.log('Getting userAgent failed: ' + err.message));
        });
    }

    protected onPaused(notification: Crdp.Debugger.PausedEvent): void {
        this._overlayHelper.doAndCancel(() => this.chrome.Page.configureOverlay({ message: ChromeDebugAdapter.PAGE_PAUSE_MESSAGE }).catch(() => { }));
        super.onPaused(notification);
    }

    protected onResumed(): void {
        this._overlayHelper.wait(() => this.chrome.Page.configureOverlay({ }).catch(() => { }));
        super.onResumed();
    }

    public disconnect(): void {
        if (this._chromeProc) {
            this._chromeProc.kill('SIGINT');
            this._chromeProc = null;
        }

        return super.disconnect();
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
