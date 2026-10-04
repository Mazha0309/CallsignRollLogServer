import { DownloadOutlined, SettingOutlined, UndoOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  ColorPicker,
  Input,
  Modal,
  Space,
  Spin,
  Switch,
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import { useRef, useState } from 'react';
import { accountApi } from '../api';
import type { ExcelExportSettings } from '../types';
import { useI18n } from '../useI18n';
import {
  DEFAULT_EXCEL_EXPORT_SETTINGS,
  exportSessionExcel,
  type SessionExcelRequest,
} from '../utils/sessionExcel';
import type { LogRecord, Page } from '../types';

interface ExcelExportActionsProps {
  title: string;
  loadLogs: (request: SessionExcelRequest) => Promise<Page<LogRecord>>;
  disabled?: boolean;
  formatError?: (error: unknown) => string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function colorHex(color: { toRgb(): { r: number; g: number; b: number; a: number } }): string {
  const { r, g, b, a } = color.toRgb();
  return `#${[r, g, b, Math.round(a * 255)]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

function cloneDefaults(): ExcelExportSettings {
  return { ...DEFAULT_EXCEL_EXPORT_SETTINGS };
}

function StylePreview({ settings }: { settings: ExcelExportSettings }) {
  const fontFamily = settings.fontFamily.trim() || undefined;
  return (
    <div className="excel-style-preview" style={{ fontFamily }}>
      <div style={{ background: settings.headerBackgroundColor }}>{settings.headerText || ' '}</div>
      <div style={{ background: settings.headerRowBackgroundColor }}>#　时间　呼号　RST发　RST收　QTH</div>
      <div style={{ background: settings.controllerBackgroundColor, fontWeight: 700 }}>点名主控:　20:00　BG5CRL</div>
      <div style={{ background: settings.tableBackgroundColor }}>1　20:01　BG5CRL　59　59　杭州</div>
      <div style={{ background: settings.useAlternateColors ? settings.alternateRowColor : settings.tableBackgroundColor }}>2　20:02　BG5ABC　59　59　宁波</div>
    </div>
  );
}

export function ExcelExportActions({
  title,
  loadLogs,
  disabled = false,
  formatError = errorText,
}: ExcelExportActionsProps) {
  const { t } = useI18n();
  const { message } = App.useApp();
  const [settings, setSettings] = useState<ExcelExportSettings | null>(null);
  const [draft, setDraft] = useState<ExcelExportSettings>(cloneDefaults);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const settingsRequest = useRef<Promise<ExcelExportSettings> | null>(null);

  const loadSettings = async (): Promise<ExcelExportSettings> => {
    if (settings) return settings;
    if (!settingsRequest.current) {
      settingsRequest.current = accountApi.excelExportSettings()
        .then((result) => {
          setSettings(result.excelExportSettings);
          return result.excelExportSettings;
        })
        .finally(() => {
          settingsRequest.current = null;
        });
    }
    return settingsRequest.current;
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    setSettingsLoadError(null);
    setSettingsSaveError(null);
    setSettingsLoading(true);
    try {
      const loaded = await loadSettings();
      setDraft({ ...loaded });
    } catch (error) {
      setSettingsLoadError(formatError(error));
    } finally {
      setSettingsLoading(false);
    }
  };

  const saveSettings = async () => {
    if (settingsSaving) return;
    setSettingsSaving(true);
    setSettingsSaveError(null);
    try {
      const result = await accountApi.updateExcelExportSettings(draft);
      setSettings(result.excelExportSettings);
      setDraft({ ...result.excelExportSettings });
      setSettingsOpen(false);
      message.success(t('sessions.excelSettingsSaved'));
    } catch (error) {
      setSettingsSaveError(formatError(error));
    } finally {
      setSettingsSaving(false);
    }
  };

  const exportExcel = async () => {
    if (exporting || disabled) return;
    setExporting(true);
    try {
      const currentSettings = await loadSettings();
      const count = await exportSessionExcel({
        title,
        settings: currentSettings,
        loadLogs,
      });
      message.success(t('sessions.exportExcelSucceeded', { count }));
    } catch (error) {
      message.error(t('sessions.exportExcelFailed', { message: formatError(error) }));
    } finally {
      setExporting(false);
    }
  };

  const update = <K extends keyof ExcelExportSettings>(
    key: K,
    value: ExcelExportSettings[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const fileTab = (
    <div className="excel-settings-section">
      <Alert showIcon type="info" message={t('sessions.excelSettingsAccountHint')} />
      <label className="excel-settings-field">
        <span>{t('sessions.excelFileNameTemplate')}</span>
        <Input
          value={draft.fileNameTemplate}
          maxLength={200}
          onChange={(event) => update('fileNameTemplate', event.target.value)}
        />
      </label>
      <div className="excel-settings-switch-row">
        <div>
          <strong>{t('sessions.excelUseSessionFileName')}</strong>
          <Typography.Paragraph type="secondary">
            {t('sessions.excelUseSessionFileNameHint')}
          </Typography.Paragraph>
        </div>
        <Switch
          checked={draft.useSessionTitleAsFileName}
          onChange={(value) => update('useSessionTitleAsFileName', value)}
        />
      </div>
      <label className="excel-settings-field">
        <span>{t('sessions.excelHeaderTemplate')}</span>
        <Input
          value={draft.headerText}
          maxLength={200}
          onChange={(event) => update('headerText', event.target.value)}
        />
      </label>
      <div className="excel-settings-switch-row">
        <div>
          <strong>{t('sessions.excelUseSessionHeader')}</strong>
          <Typography.Paragraph type="secondary">
            {t('sessions.excelUseSessionHeaderHint')}
          </Typography.Paragraph>
        </div>
        <Switch
          checked={draft.useSessionTitleAsHeader}
          onChange={(value) => update('useSessionTitleAsHeader', value)}
        />
      </div>
      <Typography.Text type="secondary">
        {t('sessions.excelTemplateVariables')}: {'{yyyy} {MM} {dd} {HH} {mm} {ss} {session}'}
      </Typography.Text>
    </div>
  );

  const colors: Array<{
    key: keyof Pick<
      ExcelExportSettings,
      | 'headerBackgroundColor'
      | 'headerRowBackgroundColor'
      | 'controllerBackgroundColor'
      | 'tableBackgroundColor'
      | 'alternateRowColor'
    >;
    label: string;
  }> = [
    { key: 'headerBackgroundColor', label: t('sessions.excelHeaderColor') },
    { key: 'headerRowBackgroundColor', label: t('sessions.excelColumnHeaderColor') },
    { key: 'controllerBackgroundColor', label: t('sessions.excelControllerColor') },
    { key: 'tableBackgroundColor', label: t('sessions.excelTableColor') },
    { key: 'alternateRowColor', label: t('sessions.excelAlternateColor') },
  ];
  const styleTab = (
    <div className="excel-settings-section">
      <StylePreview settings={draft} />
      <div className="excel-color-grid">
        {colors.map(({ key, label }) => (
          <label className="excel-color-field" key={key}>
            <span>{label}</span>
            <ColorPicker
              value={draft[key]}
              format="hex"
              showText={(color) => colorHex(color)}
              onChange={(color) => update(key, colorHex(color))}
            />
          </label>
        ))}
      </div>
      <label className="excel-settings-field">
        <span>{t('sessions.excelFont')}</span>
        <AutoComplete
          value={draft.fontFamily}
          options={[
            { value: 'SarasaGothicSC' },
            { value: 'Microsoft YaHei' },
            { value: 'Noto Sans CJK SC' },
            { value: 'SimSun' },
            { value: 'Arial' },
          ]}
          onChange={(value) => update('fontFamily', value)}
        />
      </label>
      <div className="excel-settings-switch-row">
        <strong>{t('sessions.excelAlternateRows')}</strong>
        <Switch
          checked={draft.useAlternateColors}
          onChange={(value) => update('useAlternateColors', value)}
        />
      </div>
      <div className="excel-settings-switch-row">
        <strong>{t('sessions.excelFooter')}</strong>
        <Switch
          checked={draft.showFooter}
          onChange={(value) => update('showFooter', value)}
        />
      </div>
      <Button icon={<UndoOutlined />} onClick={() => setDraft(cloneDefaults())}>
        {t('sessions.excelRestoreDefaults')}
      </Button>
    </div>
  );

  return (
    <>
      <Space.Compact>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          loading={exporting}
          disabled={disabled}
          onClick={() => void exportExcel()}
        >
          {t('sessions.exportExcel')}
        </Button>
        <Tooltip title={t('sessions.excelSettings')}>
          <Button
            aria-label={t('sessions.excelSettings')}
            icon={<SettingOutlined />}
            disabled={disabled}
            onClick={() => void openSettings()}
          />
        </Tooltip>
      </Space.Compact>
      <Modal
        open={settingsOpen}
        width={680}
        title={t('sessions.excelSettings')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={settingsSaving}
        okButtonProps={{ disabled: settingsLoading || Boolean(settingsLoadError) }}
        onOk={() => void saveSettings()}
        onCancel={() => setSettingsOpen(false)}
        destroyOnHidden
      >
        {settingsLoading ? (
          <div className="excel-settings-loading"><Spin /></div>
        ) : settingsLoadError ? (
          <Alert
            showIcon
            type="error"
            message={t('sessions.excelSettingsLoadFailed')}
            description={settingsLoadError}
            action={<Button onClick={() => void openSettings()}>{t('common.retry')}</Button>}
          />
        ) : (
          <>
            {settingsSaveError && (
              <Alert
                showIcon
                closable
                type="error"
                message={t('sessions.excelSettingsSaveFailed')}
                description={settingsSaveError}
                onClose={() => setSettingsSaveError(null)}
                style={{ marginBottom: 12 }}
              />
            )}
            <Tabs
              items={[
                { key: 'file', label: t('sessions.excelFileTab'), children: fileTab },
                { key: 'style', label: t('sessions.excelStyleTab'), children: styleTab },
              ]}
            />
          </>
        )}
      </Modal>
    </>
  );
}
