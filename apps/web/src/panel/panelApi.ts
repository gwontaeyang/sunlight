// API client used by the panels (Owner D). Defaults to the app client; tests provide a fake one.
import { createContext, useContext } from 'react';
import { api, type ApiClient } from '../api/client';

export const PanelApiContext = createContext<ApiClient>(api);
export const usePanelApi = () => useContext(PanelApiContext);
