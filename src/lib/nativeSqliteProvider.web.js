import React from 'react';

export function SQLiteProvider({ children }) {
  return <>{children}</>;
}

export function useSQLiteContext() {
  throw new Error('SQLite context is not available on web.');
}
