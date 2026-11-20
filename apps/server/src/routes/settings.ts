import { readSettings, writeSettings } from '../byok/settings';
import { routeBody, routeJson, type RouteModule } from '../deps';

export const settingsRoutes: RouteModule = (deps) => {
  const { provider } = deps.backends;
  const result = () => ({
    settings: readSettings(deps.sqlite),
    credential: provider.credentials.status(),
    aiAvailable: deps.backends.available(),
  });
  return {
    'settings.get': (c) => routeJson(c, 'settings.get', result()),
    'settings.put': async (c) => {
      writeSettings(deps.sqlite, (await routeBody(c, 'settings.put')).settings);
      return routeJson(c, 'settings.put', result());
    },
    'settings.secret.put': async (c) => {
      const { key } = await routeBody(c, 'settings.secret.put');
      return routeJson(c, 'settings.secret.put', provider.credentials.change(key));
    },
    'settings.secret.delete': (c) => routeJson(c, 'settings.secret.delete', provider.credentials.change(null)),
    'settings.secret.check': async (c) => {
      await routeBody(c, 'settings.secret.check');
      const status =
        deps.config.llmMode === 'mock'
          ? provider.credentials.status().keyConfigured
            ? 'unavailable'
            : 'missing'
          : await provider.check();
      return routeJson(c, 'settings.secret.check', { status });
    },
  };
};
