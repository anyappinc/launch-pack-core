// httpモジュールを読み込み、インスタンスを生成
const http = require('http');
const fs = require('fs');
const path = require('path');
const cookie = require('cookie');
const moment = require('moment');

const routing = require('./routing');
const distribution = require('./distribution');
const render = require('./render');
const dataManager = require('./data-manager');
const debug = require('./debug');

const launchpackPort = 1337;
const debuggerPort = 1338;

const watchers = [];
const watchingFilesHealth = {};

function fileExists(filepath) {
  return fs.existsSync(filepath);
}

function loadJsonFile(filename, filepath) {
  let contents;
  try {
    contents = JSON.parse(fs.readFileSync(filepath), 'utf-8');
  } catch (e) {
    console.error('%s\n%s', e, `[LaunchPack] failed to parse ${filename}`);
  }
  return contents;
}

function loadFile(filename, filepath, required, loadingFunc, notFoundFunc) {
  // 対象ファイルが存在しないとき
  if (!fileExists(filepath)) {
    if (notFoundFunc) {
      notFoundFunc();
    }

    if (required) {
      // 必須ファイルが見つからないときは異常終了
      console.error(`[LaunchPack] ${filename} is not found`);
      process.exit(1);
    } else {
      console.warn(`[LaunchPack] ${filename} does not exist`);
    }

    return;
  }

  if (loadingFunc()) {
    console.info(`[LaunchPack] ${filename} is loaded`);
  } else if (required) { // 必須ファイルの読み込みに失敗したとき
    if (!global.LaunchPack.DEBUG_MODE) {
      process.exit(1); // デバッグモードでなければ異常終了する
    } else {
      watchingFilesHealth[filename] = false;
    }
  }

  // デバッグモードのときはファイルの変更を監視する
  if (global.LaunchPack.DEBUG_MODE) {
    console.info(`[LaunchPack] watching ${filename}`);
    const watcher = fs.watch(filepath, (eventType) => {
      switch (eventType) {
        case 'change':
          if (loadingFunc()) {
            if (required) {
              watchingFilesHealth[filename] = true;
            }

            console.info(`[LaunchPack] ${filename} is reloaded`);
          } else if (required) { // 必須ファイルの読み込みに失敗したとき
            watchingFilesHealth[filename] = false;
          }
          break;
        case 'rename':
          console.warn(`[LaunchPack] ${filename} is gone.`);
          watcher.close();
          break;
      }
    });
    watchers.push(watcher);
  }
}

exports.launchServer = () => {
  const cwd = process.cwd();
  const viewRootDirectory = path.join(cwd, 'views');

  // 設定の読み込み（任意）
  let config = {};
  {
    const configFileName = 'launchpack.json';
    const configFilePath = path.join(cwd, configFileName);
    const loadConfig = () => {
      const configFileContents = loadJsonFile(configFileName, configFilePath);
      if (!configFileContents) {
        return false;
      }

      if (!Object.prototype.hasOwnProperty.call(
        configFileContents,
        global.LaunchPack.RUN_MODE,
      )) { // 動作モードに対する設定がないとき
        console.warn(`[LaunchPack] configurations for RunMode ${global.LaunchPack.RUN_MODE} are not specified in ${configFileName}`);
        return false;
      }

      config = configFileContents[global.LaunchPack.RUN_MODE];
      if (config.launchpack_debug_mode) {
        global.LaunchPack.DEBUG_MODE = true;
      } else {
        global.LaunchPack.DEBUG_MODE = false;
        // ファイルの監視を停止する
        if (watchers.length !== 0) {
          console.warn(`[LaunchPack] stop watching files`);
          watchers.forEach((watcher) => {
            watcher.close();
          });
        }
      }
      return true;
    };
    loadFile(configFileName, configFilePath, false, loadConfig);
  }

  // ルーティングの読み込み（必須）
  let routingConfig = {};
  {
    const routingFileName = 'routing.json';
    const routingFilePath = path.join(cwd, 'config', routingFileName);
    const loadRouting = () => {
      const routingFileContents = loadJsonFile(routingFileName, routingFilePath);
      if (!routingFileContents) {
        return false;
      }

      routingConfig = routingFileContents;
      return true;
    };
    loadFile(routingFileName, routingFilePath, true, loadRouting);
  }

  // リソース定義の読み込み（必須）
  let resources = {};
  {
    const resourcesFileName = 'resources.json';
    const resourcesFilePath = path.join(cwd, 'config', resourcesFileName);
    const loadResources = () => {
      const resourcesFileContents = loadJsonFile(resourcesFileName, resourcesFilePath);
      if (!resourcesFileContents) {
        return false;
      }

      resources = resourcesFileContents;
      return true;
    };
    loadFile(resourcesFileName, resourcesFilePath, true, loadResources);
  }

  // リソースマップの読み込み（必須）
  let resourcesmap = {};
  {
    const resourcesmapFileName = 'resourcesmap.json';
    const resourcesmapFilePath = path.join(cwd, 'public', resourcesmapFileName);
    const loadResourcesmap = () => {
      const resourcesmapFileContents = loadJsonFile(resourcesmapFileName, resourcesmapFilePath);
      if (!resourcesmapFileContents) {
        return false;
      }

      resourcesmap = resourcesmapFileContents;
      return true;
    };
    loadFile(resourcesmapFileName, resourcesmapFilePath, true, loadResourcesmap);
  }

  // カスタムスクリプトの読み込み（任意）
  let customScript = null;
  {
    const customScriptFileName = 'launchpack.js';
    const customScriptFilePath = path.join(cwd, customScriptFileName);
    const loadCustomScript = () => {
      delete require.cache[require.resolve(customScriptFilePath)];
      customScript = require(customScriptFilePath); // eslint-disable-line global-require
      return true;
    };
    loadFile(customScriptFileName, customScriptFilePath, false, loadCustomScript);
  }

  // サーバの設定と監視
  const serverLaunchTimeStamp = moment();
  http.createServer((req, res) => {
    const accessLog = debug.initAccessLog(global.LaunchPack.DEBUG_MODE);

    let reqUrl;
    try {
      reqUrl = decodeURIComponent(req.url);
    } catch (e) {
      distribution.distributePlainText(400, 'Bad Request', req, res, accessLog);
      return;
    }

    // アクセスログの出力
    console.info(`${moment().format('YYYY-MM-DD HH:mm:ss')} :: ${req.method} ${req.headers.host}${reqUrl}`);

    // デバッグモードで起動しているときは監視しているファイルの状態が正常であるかを確認する
    if (global.LaunchPack.DEBUG_MODE) {
      const badHealthFile = Object.keys(watchingFilesHealth)
        .find(filename => !watchingFilesHealth[filename]);
      if (badHealthFile) {
        distribution.distributePlainText(500, `Failed to load ${badHealthFile}`, req, res, accessLog);
        return;
      }
    }

    if (reqUrl === '/health') {
      res.setHeader('launch-date', serverLaunchTimeStamp.format());
      res.setHeader('Cache-Control', 'max-age=315360000, must-revalidate');
      distribution.distributePlainText(200, 'ok', req, res, accessLog);
      return;
    }

    /* public以下のリソースに存在しているものの場合は、そのまま返す */
    if (reqUrl in resourcesmap) {
      /* 通常のpathのものはhashしたURLから配信 */
      const hashedFilePath = path.join(cwd, 'public', 'hashed', resourcesmap[reqUrl]);
      distribution.distributeByFilePath(hashedFilePath, req, res, accessLog);
      return;
    }

    const filePath = path.join(cwd, 'public', reqUrl);
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      /* hash以下にあるものだったら、キャッシュするようにして配信 */
      res.setHeader('Cache-Control', 'max-age=315360000, must-revalidate');
      res.setHeader('Expires', new Date(Date.now() + 315360000 * 1000).toUTCString());
      distribution.distributeByFilePath(filePath, req, res, accessLog);
      return;
    }

    /* ルーティング */
    const actionAndParams = routing.findActionAndParams(routingConfig, reqUrl.split('?')[0]);
    const { actionString, actionParams } = actionAndParams;
    const actionStringToUrl = routing.generateActionStringToUrlMap(routingConfig);
    render.setRenderParams(actionStringToUrl, cwd);

    /* 使用するActionの探索 */
    let actionConfig = resources;
    const route = actionString.split('.');
    for (let i = 0; i < route.length; i++) {
      actionConfig = actionConfig[route[i]];
    }

    const reqMethod = req.method.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(actionConfig, reqMethod)) {
      actionConfig = actionConfig[reqMethod];
    }

    if (actionConfig === undefined) {
      const distributeString = 'actionConfig Not Found';
      distribution.distributePlainText(500, distributeString, req, res, accessLog);
      return;
    }
    debug.setActionConfigToAccessLog(accessLog, actionConfig);

    /* ActionConfigのURLをアクセスに応じて切り替え */
    Object.keys(actionParams).forEach((pathKey) => {
      const param = encodeURI(actionParams[pathKey]);
      const actionConfigKeys = ['api', 'json'];
      for (let i = 0; i < actionConfigKeys.length; i++) {
        const actionConfigKey = actionConfigKeys[i];
        if (Object.prototype.hasOwnProperty.call(actionParams, pathKey)
          && Object.prototype.hasOwnProperty.call(actionConfig, actionConfigKey)) {
          actionConfig[actionConfigKey] = actionConfig[actionConfigKey].replace(`{${pathKey}}`, param);
        }
      }
    });
    const isUrlReg = new RegExp('^https?://');
    if (Object.prototype.hasOwnProperty.call(actionConfig, 'api')
      && Object.prototype.hasOwnProperty.call(config, 'api_base_url')
      && !actionConfig.api.match(isUrlReg)) {
      actionConfig.api = config.api_base_url + actionConfig.api;
    }

    let statusCode = 200;
    if ('statusCode' in actionConfig) {
      ({ statusCode } = actionConfig);
    }
    res.statusCode = statusCode;

    let template = null;
    if ('template' in actionConfig) {
      ({ template } = actionConfig);
    }

    /* 埋め込むデータの探索 */
    dataManager
      .getRenderData(req, res, cwd, actionConfig, accessLog)
      .then(
        /* テンプレートを元にレンダリングする */
        (contentString) => {
          debug.setContentJsonToAccessLog(accessLog, contentString);

          let renderObj;
          try {
            renderObj = JSON.parse(contentString);
            if ('app_status_code' in renderObj) {
              res.statusCode = renderObj.app_status_code;
            }
            // リダイレクトの処理が挟まっていた場合、リダイレクトする
            if ([301, 302, 303, 307].indexOf(renderObj.app_status_code) >= 0) {
              if ('redirect' in renderObj) {
                let redirectUrl = renderObj.redirect;
                const urlReg = new RegExp('^https?:\\/\\/.*');
                const isUrl = redirectUrl.match(urlReg);
                if (!isUrl) {
                  const routeString = renderObj.redirect;
                  let params = {};
                  if ('redirect_params' in renderObj) {
                    params = renderObj.redirect_params;
                  }
                  if (routeString in actionStringToUrl) {
                    const routingUrlDir = actionStringToUrl[routeString].split('/');
                    for (let i = 0; i < routingUrlDir.length; i++) {
                      if (routingUrlDir[i].lastIndexOf(':', 0) === 0) { // 「:」からはじまる場合
                        const paramKey = routingUrlDir[i].slice(1);
                        if (paramKey in params) {
                          routingUrlDir[i] = params[paramKey];
                        }
                      }
                      routingUrlDir[i] = encodeURI(routingUrlDir[i]);
                    }
                    redirectUrl = routingUrlDir.join('/');
                  } else {
                    return Promise.reject(new Error(`リダイレクト先のURLが見つかりませんでした::${routeString}`));
                  }
                }
                res.setHeader('Location', redirectUrl);

                const cookies = [];
                if ('flash' in renderObj) {
                  cookies.push(cookie.serialize('lp-flash', JSON.stringify(renderObj.flash), { path: '/' }));
                }
                if ('set-cookie' in res.getHeaders()) {
                  cookies.push(res.getHeaders()['set-cookie']);
                }
                res.setHeader('set-cookie', cookies);
                return Promise.resolve('');
              }
              return Promise.reject(new Error('redirect先のアドレスが見つかりませんでした'));
            }
            if (template !== null) {
              return render.renderTemplate(
                config,
                req,
                res,
                viewRootDirectory,
                template,
                renderObj,
                customScript,
                actionAndParams,
              );
            }
          } catch (e) {
            if (template !== null) {
              // templateにrenderするべきなのに、JSONがparseできなかった場合はエラー処理を行う
              return Promise.reject(e);
            }
          }
          return Promise.resolve(contentString);
        }, err => Promise.reject(err),
      )
      .then(
        /* 実際に配信する */
        (resultText) => {
          distribution.distributeText(resultText, req, res, accessLog);
        },
        (err) => {
          console.log(err);
          const errorStatusCode = (typeof (err) === 'object' && 'statusCode' in err) ? err.statusCode : 500;
          res.statusCode = errorStatusCode;

          let errorTemplate = 'errors/default.ect';
          const specificErrorTemplate = path.join(cwd, 'views', 'errors', `${errorStatusCode}.ect`);
          if (fs.existsSync(specificErrorTemplate)
            && !fs.statSync(specificErrorTemplate).isDirectory()) {
            errorTemplate = `errors/${errorStatusCode}.ect`;
          }

          /* catch可能なエラーだった場合はエラーページをrenderする */
          const errorRenderObj = {
            statusCode: res.statusCode,
            err,
          };
          render.renderTemplate(
            config,
            req,
            res,
            viewRootDirectory,
            errorTemplate,
            errorRenderObj,
            customScript,
            actionAndParams,
          ).then((resultText) => {
            distribution.distributeText(resultText, req, res, accessLog);
          }, () => {
            // エラーページのレンダリングでエラーがおきたら、テキストだけのエラーを出す。
            const distributeString = `${res.statusCode} Error`;
            distribution.distributePlainText(statusCode, distributeString, req, res, accessLog);
          });
        },
      );
  }).listen(launchpackPort, '0.0.0.0');

  console.info('[LaunchPack] LaunchPack is launched! Listening on :%d', launchpackPort);

  // デバッグサーバの設定と監視
  const debugServer = http.createServer((req, res) => {
    if (!global.LaunchPack.DEBUG_MODE) {
      return;
    }

    let reqUrl;
    try {
      reqUrl = decodeURIComponent(req.url);
      if (reqUrl === '/') {
        reqUrl = '/index.html';
      }
    } catch (e) {
      distribution.distributePlainText(400, 'Bad Request', req, res, null);
      return;
    }

    const filePath = path.join(__dirname, '../', 'debug', reqUrl);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      distribution.distributePlainText(404, 'Not Found', req, res, null);
      return;
    }

    distribution.distributeByFilePath(filePath, req, res, null);
  }).listen(debuggerPort, '0.0.0.0');

  debug.init(debugServer);
  console.info('[LaunchPack] debugger is ready on :%d', debuggerPort);
};
