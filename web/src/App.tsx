import { App as AntApp, ConfigProvider, Result, Spin, theme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { PreferencesProvider, usePreferences } from './PreferencesContext';
import { useI18n } from './useI18n';

const AppShell = lazy(() => import('./components/AppShell').then((module) => ({ default: module.AppShell })));
const AuthPage = lazy(() => import('./pages/AuthPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const OverviewPage = lazy(() => import('./pages/app/OverviewPage'));
const SessionsPage = lazy(() => import('./pages/app/SessionsPage'));
const SessionDetailPage = lazy(() => import('./pages/app/SessionDetailPage'));
const PersonalSessionDetailPage = lazy(() => import('./pages/app/PersonalSessionDetailPage'));
const AccountPage = lazy(() => import('./pages/app/AccountPage'));
const ConnectPage = lazy(() => import('./pages/ConnectPage'));
const SharingPage = lazy(() => import('./pages/app/SharingPage'));
const FriendsPage = lazy(() => import('./pages/app/FriendsPage'));
const SharedSessionDetailPage = lazy(() => import('./pages/app/SharedSessionDetailPage'));
const PersonalCloudPage = lazy(() => import('./pages/app/PersonalCloudPage'));
const PublicArchiveListsPage = lazy(() => import('./pages/app/PublicArchiveListsPage'));
const PublicArchiveListDetailPage = lazy(() => import('./pages/app/PublicArchiveListDetailPage'));
const AdminOverviewPage = lazy(() => import('./pages/admin/AdminOverviewPage'));
const UsersPage = lazy(() => import('./pages/admin/UsersPage'));
const AdminSessionsPage = lazy(() => import('./pages/admin/AdminSessionsPage'));
const AdminAccountSessionsPage = lazy(() => import('./pages/admin/AdminAccountSessionsPage'));
const AdminSessionDetailPage = lazy(() => import('./pages/admin/AdminSessionDetailPage'));
const AdminPersonalSessionDetailPage = lazy(() => import('./pages/admin/AdminPersonalSessionDetailPage'));
const AdminAuditPage = lazy(() => import('./pages/admin/AdminAuditPage'));
const OperationsPage = lazy(() => import('./pages/admin/OperationsPage'));
const PublicLiveshareDetailPage = lazy(() => import('./pages/admin/PublicLiveshareDetailPage'));
const AdminSettingsPage = lazy(() => import('./pages/admin/AdminSettingsPage'));
const AdminPersonalSnapshotsPage = lazy(() => import('./pages/admin/AdminPersonalSnapshotsPage'));
const AdminPersonalSnapshotDetailPage = lazy(() => import('./pages/admin/AdminPersonalSnapshotDetailPage'));
const AdminPublicArchiveListsPage = lazy(() => import('./pages/admin/PublicArchiveListsPage'));

function FullPageLoading() {
  const { t } = useI18n();
  return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><Spin size="large" tip={t('auth.sessionRestoring')}><div style={{ width: 180, height: 80 }} /></Spin></div>;
}

function ProtectedRoute() {
  const { user, initializing } = useAuth();
  const location = useLocation();
  if (initializing) return <FullPageLoading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (user.mustChangePassword && location.pathname !== '/app/account') return <Navigate to="/app/account" replace />;
  return <Outlet />;
}

function AdminRoute() {
  const { user } = useAuth();
  const { t } = useI18n();
  if (user?.role !== 'admin') return <Result status="403" title="403" subTitle={t('error.FORBIDDEN')} />;
  return <Outlet />;
}

function AppRoutes() {
  return <Suspense fallback={<FullPageLoading />}><Routes>
    <Route path="/login" element={<AuthPage mode="login" />} />
    <Route path="/register" element={<AuthPage mode="register" />} />
    <Route path="/bootstrap" element={<AuthPage mode="bootstrap" />} />
    <Route path="/connect" element={<ConnectPage />} />
    <Route element={<ProtectedRoute />}>
      <Route path="/app" element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="sessions/collaboration/:sessionId" element={<SessionDetailPage />} />
        <Route path="sessions/personal/:sessionId" element={<PersonalSessionDetailPage />} />
        <Route path="sessions/:sessionId" element={<SessionDetailPage />} />
        <Route path="sessions/shared/:source/:sessionId" element={<SharedSessionDetailPage />} />
        <Route path="friends" element={<FriendsPage />} />
        <Route path="sharing" element={<Navigate to="/app/friends" replace />} />
        <Route path="legacy-sharing" element={<SharingPage />} />
        <Route path="personal-cloud" element={<PersonalCloudPage />} />
        <Route path="public-archives" element={<PublicArchiveListsPage />} />
        <Route path="public-archives/:listId" element={<PublicArchiveListDetailPage />} />
        <Route path="account" element={<AccountPage />} />
      </Route>
      <Route element={<AdminRoute />}>
        <Route path="/admin" element={<AppShell admin />}>
          <Route index element={<AdminOverviewPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="sessions" element={<AdminSessionsPage />} />
          <Route path="sessions/accounts/:userId" element={<AdminAccountSessionsPage />} />
          <Route path="sessions/accounts/:userId/collaboration/:sessionId" element={<AdminSessionDetailPage />} />
          <Route path="sessions/accounts/:userId/personal/:sessionId" element={<AdminPersonalSessionDetailPage />} />
          <Route path="sessions/:sessionId" element={<AdminSessionDetailPage />} />
          <Route path="personal-snapshots" element={<AdminPersonalSnapshotsPage />} />
          <Route path="personal-snapshots/:userId" element={<AdminPersonalSnapshotDetailPage />} />
          <Route path="public-archives" element={<AdminPublicArchiveListsPage />} />
          <Route path="audit" element={<AdminAuditPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="operations/liveshares/:publicShareId" element={<PublicLiveshareDetailPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>
      </Route>
    </Route>
    <Route path="/" element={<Navigate to="/app" replace />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes></Suspense>;
}

function ThemedApp() {
  const { dark, locale } = usePreferences();
  return <ConfigProvider locale={locale === 'zh-CN' ? zhCN : enUS} theme={{
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: '#1677ff', borderRadius: 8, fontSize: 14 },
    components: { Layout: { bodyBg: 'var(--app-bg)', headerBg: 'var(--app-elevated)', siderBg: 'var(--app-elevated)' }, Menu: { itemBorderRadius: 7 } },
  }}><AntApp><AuthProvider><AppRoutes /></AuthProvider></AntApp></ConfigProvider>;
}

export default function App() {
  return <PreferencesProvider><ThemedApp /></PreferencesProvider>;
}
