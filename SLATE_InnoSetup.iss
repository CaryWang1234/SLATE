; ─────────────────────────────────────────────────────────────
; SLATE（砚）Windows 安装程序
; 编译：ISCC SLATE_InnoSetup.iss（或运行 build_installer.bat）
; ─────────────────────────────────────────────────────────────

#define MyAppName "SLATE 砚"
#define MyAppVersion "0.3.0"
; 构建号（yyyyMMddHHmm），每次发布构建时更新
#define MyAppBuild "202608171200"
#define MyAppPublisher "SLATE"
#define MyAppURL "https://github.com/CaryWang1234/SLATE"
#define MyAppExeName "SLATE.exe"
#define MyAppSourceDir "dist\SLATE"
; WebView2 运行时注册表 GUID（pywebview 依赖）
#define WebView2ClientGuid "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

[Setup]
AppId={{8B01808E-0B0F-4C57-A556-4C6A87DF28E2}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
AppComments=本地 AI 协作调度台：提示词工程与上下文管理 (Build {#MyAppBuild})
AppContact={#MyAppURL}/issues
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 默认按当前用户安装，但允许用户在向导中选择"为所有用户安装"
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
; Windows 10 及以上（WebView2 要求）
MinVersion=10.0
LicenseFile=LICENSE
OutputDir=installer
OutputBaseFilename=SLATE-Setup-{#MyAppVersion}
SetupIconFile=app.ico
; 防止多个安装程序实例同时运行
SetupMutex=SLATESetupMutex
SetupLogging=yes
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
CloseApplications=yes
RestartApplications=no
; 版本信息（写入安装包属性页）
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序 (Build {#MyAppBuild})
VersionInfoProductName={#MyAppName}
VersionInfoCopyright=Copyright (c) {#MyAppPublisher}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: checkedonce
Name: "autostart"; Description: "开机自动启动 {#MyAppName}"; GroupDescription: "附加选项："; Flags: unchecked
Name: "userdata"; Description: "卸载时保留用户数据（聊天记录 / 技能 / 设置）"; GroupDescription: "卸载行为："; Flags: checkedonce

[Registry]
; 开机自启（随 autostart 任务创建，卸载时自动移除）
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
    ValueName: "SLATE"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"""; \
    Flags: uninsdeletevalue; Tasks: autostart
; “卸载时保留用户数据”标记（供卸载程序读取）
Root: HKCU; Subkey: "Software\SLATE"; \
    ValueName: "KeepUserData"; ValueType: dword; ValueData: "1"; \
    Flags: uninsdeletevalue; Tasks: userdata

[Dirs]
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\data\skills"; Flags: uninsneveruninstall
Name: "{app}\data\webview_profile"; Flags: uninsneveruninstall

[Files]
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "desktop_backend.log,*.log,data\*"
Source: "{#MyAppSourceDir}\data\constitution.json"; DestDir: "{app}\data"; Flags: ignoreversion onlyifdoesntexist skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent shellexec

[InstallDelete]
; 清理旧版本 PyInstaller 产物，避免残留
Type: filesandordirs; Name: "{app}\_internal"

[UninstallDelete]
Type: files; Name: "{app}\desktop_backend.log"
Type: files; Name: "{app}\*.log"

[Code]
// ── 应用界面语言选择（安装时选择，写入 data/language.txt，应用运行时只读） ──
var
  LangPage: TInputOptionWizardPage;
  LangZhIndex: Integer;
  LangEnIndex: Integer;

procedure InitializeWizard;
begin
  LangPage := CreateInputOptionPage(wpSelectTasks,
    '应用语言 / Application Language',
    '选择 SLATE 的界面语言 / Choose the interface language of SLATE',
    '安装完成后可通过重装更改。' + #13#10 +
    'This can be changed by reinstalling.',
    True, False);
  LangZhIndex := LangPage.Add('简体中文 (Chinese)');
  LangEnIndex := LangPage.Add('English (英文)');
  // 默认跟随系统语言：非简体中文环境默认英文
  if GetUILanguage and $3FF = $04 then
    LangPage.Values[LangZhIndex] := True
  else
    LangPage.Values[LangEnIndex] := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  lang: String;
  langFile: String;
begin
  if CurStep = ssPostInstall then
  begin
    langFile := ExpandConstant('{app}\data\language.txt');
    // 静默升级时保留用户已有语言选择；交互式安装始终按页面选择写入
    if WizardSilent and FileExists(langFile) then
      Exit;
    if LangPage.Values[LangEnIndex] then
      lang := 'en'
    else
      lang := 'zh';
    ForceDirectories(ExpandConstant('{app}\data'));
    SaveStringToFile(langFile, lang, False);
  end;
end;

// 检测 WebView2 运行时是否已安装（pywebview 依赖）
function IsWebView2Installed: Boolean;
var
  pv: String;
begin
  Result :=
    RegQueryStringValue(HKLM,
      'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{#WebView2ClientGuid}',
      'pv', pv) and (pv <> '')
    or
    RegQueryStringValue(HKCU,
      'SOFTWARE\Microsoft\EdgeUpdate\Clients\{#WebView2ClientGuid}',
      'pv', pv) and (pv <> '');
end;

// 安装前检查：缺少 WebView2 时提示并给出下载入口
function InitializeSetup: Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not IsWebView2Installed then
  begin
    if MsgBox(
      '未检测到 Microsoft Edge WebView2 运行时。' + #13#10 +
      'SLATE 桌面窗口依赖该组件，缺少时可能无法显示界面。' + #13#10#13#10 +
      '是否打开微软官方下载页面？（也可稍后自行安装）',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/',
        '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
    end;
  end;
end;

// 卸载完成后：按安装时的选择决定是否清除用户数据
var
  KeepUserData: Boolean;

// 卸载程序启动时最先执行；注册表标记会在卸载过程中被删除，必须先缓存
function InitializeUninstall: Boolean;
var
  v: DWord;
begin
  Result := True;
  KeepUserData :=
    RegQueryDWordValue(HKCU, 'Software\SLATE', 'KeepUserData', v) and (v = 1);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if not KeepUserData then
    begin
      if MsgBox(
        '是否同时删除用户数据（聊天记录、自定义技能、设置）？' + #13#10 +
        '选择"否"将保留数据，重新安装后可继续使用。',
        mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(ExpandConstant('{app}\data'), True, True, True);
      end;
    end;
  end;
end;
