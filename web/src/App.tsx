import { useCallback, useState } from "react";
import { AuthScreen } from "./components/AuthScreen.js";
import { ChatScreen } from "./components/ChatScreen.js";
import { ConfirmProvider } from "./components/ConfirmDialog.js";
import { ToastProvider } from "./components/Toast.js";
import { api, readSession, writeSession } from "./lib/api.js";
import { useTheme } from "./hooks/useTheme.js";

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Shell() {
  const [token, setToken] = useState<string>(() => readSession());
  const [theme, setTheme] = useTheme();

  const unauthorized = useCallback(() => {
    writeSession("");
    setToken("");
  }, []);

  const logout = useCallback(() => {
    const current = readSession();
    if (current) void api.logout(current).catch(() => {});
    unauthorized();
  }, [unauthorized]);

  return token ? (
    <ChatScreen token={token} theme={theme} onTheme={setTheme} onLogout={logout} onUnauthorized={unauthorized} />
  ) : (
    <AuthScreen onSession={setToken} />
  );
}
