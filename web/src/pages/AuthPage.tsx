import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Segmented, Space, Typography } from 'antd';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { ApiError, authApi } from '../api';
import { usePreferences } from '../PreferencesContext';
import { useI18n } from '../useI18n';
import { isLegacyCompatibleLogin, submittedUsername, type AuthMode } from '../utils/authCredentials';

interface Values { username: string; password: string; confirmPassword?: string; bootstrapSecret?: string }

export default function AuthPage({ mode }: { mode: AuthMode }) {
  const { user, login, register } = useAuth();
  const { locale, setLocale, themeMode, setThemeMode } = usePreferences();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordChangeToken, setPasswordChangeToken] = useState<string | null>(null);
  const legacyCompatibleLogin = isLegacyCompatibleLogin(mode, Boolean(passwordChangeToken));
  if (user) return <Navigate to={user.mustChangePassword ? '/app/account' : '/app'} replace />;

  const submit = async (values: Values) => {
    if ((mode === 'register' || mode === 'bootstrap' || passwordChangeToken) && values.password !== values.confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (passwordChangeToken) {
        await authApi.completePasswordChange(passwordChangeToken, values.password);
        navigate('/app', { replace: true });
        return;
      }
      const username = submittedUsername(mode, values.username);
      const authenticated = mode === 'login'
        ? await login(username, values.password)
        : mode === 'register'
          ? await register(username, values.password)
          : (await authApi.bootstrap(username, values.password, values.bootstrapSecret ?? '')).user;
      const redirect = (location.state as { from?: string } | null)?.from;
      navigate(redirect ?? (authenticated.mustChangePassword ? '/app/account' : '/app'), { replace: true });
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'PASSWORD_CHANGE_REQUIRED') {
        const details = reason.details as { passwordChangeToken?: unknown } | undefined;
        if (typeof details?.passwordChangeToken === 'string') {
          setPasswordChangeToken(details.passwordChangeToken);
          setError(null);
          return;
        }
      }
      setError(reason instanceof ApiError ? `${reason.message} (${reason.code})` : t('auth.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-top-actions">
        <Segmented size="small" value={locale} options={[{ label: '中文', value: 'zh-CN' }, { label: 'EN', value: 'en-US' }]} onChange={(value) => setLocale(value as 'zh-CN' | 'en-US')} />
        <Segmented size="small" value={themeMode} options={[{ label: '◐', value: 'system' }, { label: '☀', value: 'light' }, { label: '☾', value: 'dark' }]} onChange={(value) => setThemeMode(value as 'system' | 'light' | 'dark')} />
      </div>
      <aside className="auth-aside">
        <div><img className="brand-mark auth-brand-mark" src="/openlogtool-logo.png" alt="Callsign Roll Log" /><Typography.Title>Callsign Roll Log</Typography.Title><p>{t('brand.subtitle')}</p></div>
        <small>Callsign Roll Log Server WebUI</small>
      </aside>
      <main className="auth-panel">
        <Card className="auth-card">
          <Typography.Title level={2}>{passwordChangeToken ? t('auth.passwordChangeRequired') : mode === 'login' ? t('auth.loginTitle') : mode === 'register' ? t('auth.registerTitle') : t('auth.bootstrapTitle')}</Typography.Title>
          {passwordChangeToken && <Alert style={{ marginBottom: 18 }} type="warning" showIcon message={t('auth.passwordChangeHint')} />}
          {error && <Alert style={{ marginBottom: 18 }} type="error" showIcon message={error} />}
          <Form layout="vertical" size="large" onFinish={submit} requiredMark={false}>
            {!passwordChangeToken && <Form.Item label={t('auth.username')} name="username" extra={t('auth.usernameIdentityHint')} rules={legacyCompatibleLogin ? [{ required: true }] : [{ required: true }, { min: 3 }, { max: 64 }]}>
              <Input prefix={<UserOutlined />} autoComplete="username" autoCapitalize="none" autoFocus />
            </Form.Item>}
            {mode === 'bootstrap' && <Form.Item label={t('auth.bootstrapSecret')} name="bootstrapSecret" rules={[{ required: true }]}><Input.Password autoComplete="off" /></Form.Item>}
            <Form.Item label={passwordChangeToken ? t('account.newPassword') : t('auth.password')} name="password" rules={legacyCompatibleLogin ? [{ required: true }] : [{ required: true }, { min: 8 }, { max: 128 }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete={mode === 'login' && !passwordChangeToken ? 'current-password' : 'new-password'} autoFocus={Boolean(passwordChangeToken)} />
            </Form.Item>
            {(mode === 'register' || mode === 'bootstrap' || passwordChangeToken) && <Form.Item label={t('auth.confirmPassword')} name="confirmPassword" dependencies={['password']} rules={[{ required: true }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
            </Form.Item>}
            <Button block type="primary" htmlType="submit" loading={submitting}>{passwordChangeToken ? t('common.save') : mode === 'login' ? t('auth.login') : mode === 'register' ? t('auth.register') : t('auth.bootstrap')}</Button>
          </Form>
          {!passwordChangeToken && <Space style={{ marginTop: 18 }}>
            <Typography.Text type="secondary">{mode === 'login' ? t('auth.noAccount') : t('auth.hasAccount')}</Typography.Text>
            <Link to={mode === 'login' ? '/register' : '/login'}>{mode === 'login' ? t('auth.register') : t('auth.login')}</Link>
            {mode === 'register' && <Link to="/bootstrap">{t('auth.bootstrap')}</Link>}
          </Space>}
        </Card>
      </main>
    </div>
  );
}
