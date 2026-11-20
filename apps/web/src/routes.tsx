// The 4 app routes (PLAN 8). Owner: supervisor.
import { Route, Switch } from 'wouter';
import { LibraryPage } from './library/LibraryPage';
import { ReviewPage } from './review/ReviewPage';
import { SettingsPage } from './settings/SettingsPage';
import { ReaderPage } from './viewer/ReaderPage';

export const APP_ROUTES = { library: '/', reader: '/paper/:id', review: '/review', settings: '/settings' } as const;

export function AppRoutes() {
  return (
    <Switch>
      <Route path={APP_ROUTES.library} component={LibraryPage} />
      <Route path={APP_ROUTES.reader}>{(params: { id: string }) => <ReaderPage key={params.id} paperId={params.id} />}</Route>
      <Route path={APP_ROUTES.review} component={ReviewPage} />
      <Route path={APP_ROUTES.settings} component={SettingsPage} />
      <Route>
        <div className="p-4">페이지가 없습니다.</div>
      </Route>
    </Switch>
  );
}
