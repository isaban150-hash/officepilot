import type { ReactNode } from 'react';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import type { CompanySetup } from '../types/models';
import { DEFAULT_SETUP } from '../data/mockData';

interface TestProvidersProps {
  children: ReactNode;
  initialSetup?: CompanySetup;
}

export function TestProviders({
  children,
  initialSetup = DEFAULT_SETUP,
}: TestProvidersProps) {
  return (
    <AuthProvider>
      <AppProvider initialSetup={initialSetup}>{children}</AppProvider>
    </AuthProvider>
  );
}
