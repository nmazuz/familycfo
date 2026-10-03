import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the UI and the desktop app: window.familycfo. Pages opened from the phone or in a
 * browser don't have it, so the bank-accounts screen appears only in the app. Bank logins go in and never come
 * back out; listing returns the field names only.
 */
contextBridge.exposeInMainWorld('familycfo', {
  version: ipcRenderer.sendSync('app:version') as string,
  bankLogins: {
    list: () => ipcRenderer.invoke('logins:list'),
    /** where they are kept: the OS store, or a master password */
    store: () => ipcRenderer.invoke('logins:store'),
    save: (login: { id?: string; companyId: string; label?: string; credentials: Record<string, string> }) =>
      ipcRenderer.invoke('logins:save', login),
    remove: (id: string) => ipcRenderer.invoke('logins:remove', id),
  },
  /** the app needs the master password (only where the OS has no credential store) */
  onPasswordRequest: (handler: (mode: 'create' | 'unlock' | 'retry') => void) => {
    const listener = (_: unknown, mode: 'create' | 'unlock' | 'retry') => handler(mode);
    ipcRenderer.on('password-request', listener);
    return () => { ipcRenderer.removeListener('password-request', listener); };
  },
  /** the typed password, or null = cancel */
  answerPassword: (password: string | null) => ipcRenderer.invoke('logins:password', password),
  /** the app asks the page to show a route (a notification was clicked) */
  onNavigate: (handler: (path: string) => void) => {
    const listener = (_: unknown, path: string) => handler(path);
    ipcRenderer.on('navigate', listener);
    return () => { ipcRenderer.removeListener('navigate', listener); };
  },
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
});
