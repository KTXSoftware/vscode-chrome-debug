/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const core = require('../core');
import * as path from 'path';

// Start a ChromeDebugSession configured to only match 'page' targets, which are Chrome tabs
core.ChromeDebugSession.run(core.ChromeDebugSession.getSession(
    {
        targetFilter: target => target && (!target.type || target.type === 'page'),
        logFileDirectory: path.resolve(__dirname, '../')
    }));

/* tslint:disable:no-var-requires */
core.logger.log('debugger-for-chrome: ' + require('../package.json').version);