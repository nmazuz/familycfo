import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/** What the Mac app (desktop/preload.ts) adds to the page. Undefined in a browser (npm run dev). */
export interface BankLoginInfo { id: string; companyId: string; label: string; fields: string[] }
export type PasswordMode = 'create' | 'unlock' | 'retry';
export interface DesktopBridge {
  version: string;
  bankLogins: {
    list(): Promise<BankLoginInfo[]>;
    store(): Promise<{ backend: 'system' | 'password'; name: string; locked: boolean }>;
    save(login: { id?: string; companyId: string; label?: string; credentials: Record<string, string> }): Promise<BankLoginInfo>;
    remove(id: string): Promise<void>;
  };
  onPasswordRequest(handler: (mode: PasswordMode) => void): () => void;
  answerPassword(password: string | null): Promise<void>;
  onNavigate(handler: (path: string) => void): () => void;
  checkForUpdates(): Promise<string | null>;
}

export const desktop = (window as unknown as { familycfo?: DesktopBridge }).familycfo;

/** The app shows a route when a notification is clicked. */
export function useDesktopNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => desktop?.onNavigate(path => navigate(path)), [navigate]);
}
