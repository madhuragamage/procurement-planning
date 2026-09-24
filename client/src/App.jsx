import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { AppProvider } from './context/AppContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import TopNav from './components/TopNav.jsx';

import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import BoardPage from './pages/BoardPage.jsx';
import RequestsPage from './pages/RequestsPage.jsx';
import AuthorisationsPage from './pages/AuthorisationsPage.jsx';
import InboxPage from './pages/InboxPage.jsx';
import PlanPage from './pages/PlanPage.jsx';
import RevisionsPage from './pages/RevisionsPage.jsx';
import ExecutionPage from './pages/ExecutionPage.jsx';
import BudgetsPage from './pages/BudgetsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import AdminPage from './pages/AdminPage.jsx';

function Guard({ roles, children }) {
  const { user } = useAuth();
  if (roles && !roles.includes(user.role)) return <Navigate to="/app/dashboard" replace />;
  return children;
}

function ProtectedShell() {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <AppProvider>
      <TopNav />
      <main>
        <Routes>
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="board" element={<Guard roles={['executive', 'management', 'admin', 'procurement']}><BoardPage /></Guard>} />
          <Route path="requests" element={<Guard roles={['requester', 'dept_head', 'procurement', 'admin']}><RequestsPage /></Guard>} />
          <Route path="authorisations" element={<Guard roles={['dept_head', 'admin']}><AuthorisationsPage /></Guard>} />
          <Route path="inbox" element={<Guard roles={['procurement', 'admin']}><InboxPage /></Guard>} />
          <Route path="plan" element={<PlanPage />} />
          <Route path="revisions" element={<Guard roles={['procurement', 'management', 'admin', 'executive']}><RevisionsPage /></Guard>} />
          <Route path="execution" element={<ExecutionPage />} />
          <Route path="budgets" element={<BudgetsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="admin" element={<Guard roles={['admin']}><AdminPage /></Guard>} />
          <Route path="*" element={<Navigate to="dashboard" replace />} />
        </Routes>
      </main>
    </AppProvider>
  );
}

function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/app/dashboard" replace />;
  return children;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
          <Route path="/app/*" element={<ProtectedShell />} />
          <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </ThemeProvider>
  );
}
