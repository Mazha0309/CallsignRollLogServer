import {
  AppstoreOutlined,
  AuditOutlined,
  CloudOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  ShareAltOutlined,
  TeamOutlined,
  UserOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Drawer, Dropdown, Layout, Menu, Space, Tooltip, type MenuProps } from 'antd';
import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { usePreferences } from '../PreferencesContext';
import { useI18n } from '../useI18n';

function PreferenceMenu() {
  const { t } = useI18n();
  const { locale, setLocale, themeMode, setThemeMode } = usePreferences();
  const items: MenuProps['items'] = [
    { type: 'group', label: t('appearance.language'), children: [
      { key: 'locale-zh', label: '简体中文', icon: locale === 'zh-CN' ? '✓' : null },
      { key: 'locale-en', label: 'English', icon: locale === 'en-US' ? '✓' : null },
    ] },
    { type: 'divider' },
    { type: 'group', label: t('appearance.theme'), children: [
      { key: 'theme-system', label: t('theme.system'), icon: themeMode === 'system' ? '✓' : null },
      { key: 'theme-light', label: t('theme.light'), icon: themeMode === 'light' ? '✓' : null },
      { key: 'theme-dark', label: t('theme.dark'), icon: themeMode === 'dark' ? '✓' : null },
    ] },
  ];
  return (
    <Dropdown menu={{ items, onClick: ({ key }) => {
      if (key === 'locale-zh') setLocale('zh-CN');
      if (key === 'locale-en') setLocale('en-US');
      if (key === 'theme-system') setThemeMode('system');
      if (key === 'theme-light') setThemeMode('light');
      if (key === 'theme-dark') setThemeMode('dark');
    } }} trigger={['click']}>
      <Button type="text" icon={<GlobalOutlined />} aria-label={t('appearance.language')} />
    </Dropdown>
  );
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n();
  return <div className="brand"><img className="brand-mark" src="/openlogtool-logo.png" alt="OpenLogTool" />{!collapsed && <div className="brand-copy"><div className="brand-title">OpenLogTool</div><div className="brand-subtitle">{t('brand.subtitle')}</div></div>}</div>;
}

export function AppShell({ admin = false }: { admin?: boolean }) {
  const { user, logout } = useAuth();
  const { dark } = usePreferences();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('olt.web.sidebar-collapsed') === 'true');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const width = collapsed ? 72 : 256;

  const items = useMemo<MenuProps['items']>(() => admin ? [
    { key: '/admin', icon: <HomeOutlined />, label: t('nav.adminOverview') },
    { key: '/admin/users', icon: <TeamOutlined />, label: t('nav.users') },
    { key: '/admin/sessions', icon: <DatabaseOutlined />, label: t('nav.allSessions') },
    { key: '/admin/personal-snapshots', icon: <CloudOutlined />, label: t('nav.personalSnapshots') },
    { key: '/admin/public-archives', icon: <GlobalOutlined />, label: t('nav.publicArchives') },
    { key: '/admin/audit', icon: <AuditOutlined />, label: t('nav.audit') },
    { key: '/admin/operations', icon: <ToolOutlined />, label: t('nav.operations') },
    { key: '/admin/settings', icon: <SettingOutlined />, label: t('nav.settings') },
    { type: 'divider' },
    { key: '/app', icon: <AppstoreOutlined />, label: t('nav.memberPortal') },
  ] : [
    { key: '/app', icon: <HomeOutlined />, label: t('nav.overview') },
    { key: '/app/sessions', icon: <DatabaseOutlined />, label: t('nav.sessions') },
    { key: '/app/sharing', icon: <ShareAltOutlined />, label: t('nav.sharing') },
    { key: '/app/personal-cloud', icon: <CloudOutlined />, label: t('nav.personalCloud') },
    { key: '/app/public-archives', icon: <GlobalOutlined />, label: t('nav.publicArchives') },
    { key: '/app/account', icon: <UserOutlined />, label: t('nav.account') },
    ...(user?.role === 'admin' ? [{ type: 'divider' as const }, { key: '/admin', icon: <SettingOutlined />, label: t('nav.admin') }] : []),
  ], [admin, t, user?.role]);

  const selected = location.pathname === '/admin' || location.pathname === '/app' ? location.pathname
    : [...(items ?? [])].filter((item): item is Exclude<NonNullable<MenuProps['items']>[number], null> & { key: string } => Boolean(item && 'key' in item && typeof item.key === 'string'))
      .map((item) => item.key).filter((key) => location.pathname.startsWith(key)).sort((a, b) => b.length - a.length)[0];
  const selectMenuItem: MenuProps['onClick'] = ({ key }) => {
    navigate(key);
    setDrawerOpen(false);
  };
  const desktopMenu = <Menu className="sidebar-menu" mode="inline" theme={dark ? 'dark' : 'light'} inlineCollapsed={collapsed} items={items} selectedKeys={selected ? [selected] : []} onClick={selectMenuItem} />;
  const mobileMenu = <Menu className="sidebar-menu" mode="inline" theme={dark ? 'dark' : 'light'} inlineCollapsed={false} items={items} selectedKeys={selected ? [selected] : []} onClick={selectMenuItem} />;
  const toggle = () => setCollapsed((value) => { localStorage.setItem('olt.web.sidebar-collapsed', String(!value)); return !value; });

  return (
    <Layout className="app-shell">
      <Layout.Sider className="app-sider" theme={dark ? 'dark' : 'light'} width={256} collapsedWidth={72} collapsed={collapsed} trigger={null}>
        <Brand collapsed={collapsed} />
        {desktopMenu}
        <div className="sidebar-footer">
          <Tooltip title={collapsed ? t('nav.expand') : t('nav.collapse')} placement="right">
            <Button block type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={toggle}>{!collapsed && t('nav.collapse')}</Button>
          </Tooltip>
        </div>
      </Layout.Sider>
      <Drawer className="mobile-nav-drawer" placement="left" width={280} open={drawerOpen} onClose={() => setDrawerOpen(false)} styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}>
        <Brand />{mobileMenu}
      </Drawer>
      <Layout className="shell-main" style={{ marginInlineStart: width }}>
        <Layout.Header className="shell-header">
          <Space size={4}>
            <Button className="mobile-only" type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} />
            <span className="desktop-only" style={{ color: 'var(--app-muted)', fontSize: 13 }}>{admin ? t('nav.admin') : t('nav.memberPortal')}</span>
          </Space>
          <div className="header-actions">
            <PreferenceMenu />
            <div className="user-chip">
              <Avatar size={30} icon={<UserOutlined />} />
              <div className="user-chip-copy"><div className="user-chip-name">{user?.username}</div><div className="user-chip-role">{user ? t(`role.${user.role}`) : ''}</div></div>
            </div>
            <Tooltip title={t('auth.logout')}><Button type="text" icon={<LogoutOutlined />} onClick={async () => { await logout(); navigate('/login', { replace: true }); }} /></Tooltip>
          </div>
        </Layout.Header>
        <Layout.Content className="shell-content"><Outlet /></Layout.Content>
      </Layout>
    </Layout>
  );
}
