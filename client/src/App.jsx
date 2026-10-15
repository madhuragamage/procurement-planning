import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { AppProvider, useApp } from './context/AppContext.jsx';
import { canSeeSupplies } from './lib/format.js';
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
import TecPage from './pages/TecPage.jsx';
import SuppliesPage from './pages/SuppliesPage.jsx';
import SuppliesProgressPage from './pages/SuppliesProgressPage.jsx';
import BudgetsPage from './pages/BudgetsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import AdminPage from './pages/AdminPage.jsx';

function Guard({ roles, children }) {
  const { user } = useAuth();
  if (roles && !roles.includes(user.role)) return <Navigate to="/app/dashboard" replace />;
  return children;
}

// Supplies Unit officers work only with their Supplies files; everything else sends them to Supplies progress.
function NotSupplies({ children }) {
  const { user } = useAuth();
  return user.role === 'supplies' ? <Navigate to="/app/supplies-progress" replace /> : children;
}

function SuppliesGuard({ children }) {
  const { user } = useAuth();
  const { lookups } = useApp();
  return canSeeSupplies(user, lookups) ? children : <Navigate to="/app/dashboard" replace />;
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
          <Route path="dashboard" element={<NotSupplies><DashboardPage /></NotSupplies>} />
          <Route path="board" element={<Guard roles={['executive', 'management', 'admin', 'procurement']}><BoardPage /></Guard>} />
          <Route path="requests" element={<Guard roles={['requester', 'dept_head', 'procurement', 'admin']}><RequestsPage /></Guard>} />
          <Route path="authorisations" element={<Guard roles={['dept_head', 'admin']}><AuthorisationsPage /></Guard>} />
          <Route path="inbox" element={<Guard roles={['procurement', 'admin']}><InboxPage /></Guard>} />
          <Route path="plan" element={<NotSupplies><PlanPage /></NotSupplies>} />
          <Route path="revisions" element={<Guard roles={['procurement', 'management', 'admin', 'executive']}><RevisionsPage /></Guard>} />
          <Route path="execution" element={<NotSupplies><ExecutionPage /></NotSupplies>} />
          <Route path="supplies" element={<SuppliesGuard><SuppliesPage /></SuppliesGuard>} />
          <Route path="supplies-progress" element={<SuppliesGuard><SuppliesProgressPage /></SuppliesGuard>} />
          <Route path="tec" element={<Guard roles={['procurement', 'management', 'admin', 'executive']}><TecPage /></Guard>} />
          <Route path="budgets" element={<NotSupplies><BudgetsPage /></NotSupplies>} />
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
