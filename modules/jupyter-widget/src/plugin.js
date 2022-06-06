/**
 * Plugin boilerplate required for JupyterLab
 * See:
 * https://github.com/jupyter-widgets/widget-ts-cookiecutter/blob/51e9fed8687e3b9cf1ed2fd307b7675e864f89ae/%7B%7Bcookiecutter.github_project_name%7D%7D/src/plugin.ts
 */
import {IJupyterWidgetRegistry} from '@jupyter-widgets/base';
import * as widgetExports from './index';

const EXTENSION_ID = '@deck.gl/jupyter-widget:plugin';

const widgetPlugin = {
  id: EXTENSION_ID,
  requires: [IJupyterWidgetRegistry],
  activate: activateWidgetExtension,
  autoStart: true
};

export default widgetPlugin;
function activateWidgetExtension(app, registry) {
  console.log("deck.gl jupyter-widget MODULE_NAME:", widgetExports.MODULE_NAME, "MODULE_VERSION:", widgetExports.MODULE_VERSION);
  registry.registerWidget({
    name: widgetExports.MODULE_NAME,
    version: widgetExports.MODULE_VERSION,
    exports: widgetExports
  });
}
