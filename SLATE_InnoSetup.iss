; ─────────────────────────────────────────────────────────────
; SLATE（砚）Windows 安装程序
; 编译：ISCC SLATE_InnoSetup.iss（或运行 build_installer.bat）
; 语言：向导第一步选择安装包语言（简体中文 / English），
;       应用界面语言在后续步骤另选（见 [Code] LangPage）
; ─────────────────────────────────────────────────────────────

#define MyAppName "SLATE 砚"
#define MyAppVersion "0.3.5"
; 构建号（yyyyMMddHHmm），每次发布构建时更新
#define MyAppBuild "202608290925"
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
AppComments=本地 AI 智能体平台 / Local AI Agentic Platform (Build {#MyAppBuild})
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
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
CloseApplications=yes
RestartApplications=no
; 版本信息（写入安装包属性页）
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序 Installer (Build {#MyAppBuild})
VersionInfoProductName={#MyAppName}
VersionInfoCopyright=Copyright (c) {#MyAppPublisher}

; 安装包语言：向导第一步弹出语言选择对话框（2 种语言以上时自动出现）。
; 简体中文使用随仓库分发的官方翻译 installer\ChineseSimplified.isl；
; 列表第一项为默认预选语言。
[Languages]
Name: "chinesesimp"; MessagesFile: "installer\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

; 向导文案按语言提供：无前缀为英文（也是缺省回退），chinesesimp. 前缀为简体中文。
; 注意：覆盖内置消息名时（如 WelcomeLabel1），每种语言都要有定义，
; 否则该语言会回退使用第一种语言的定义。
[CustomMessages]
SetupWindowTitle=SLATE Setup
WelcomeLabel1=Welcome to the {#MyAppName} Setup Wizard
WelcomeLabel2=This will install {#MyAppName} on your computer. It is recommended that you close all other applications before continuing.
SelectTasksLabel1=Select the additional tasks you would like Setup to perform while installing {#MyAppName}, then click Next.
SelectTasksLabel2=Which additional tasks should be performed?
ReadyLabel1=Ready to Install
ReadyLabel2=Click Install to continue with the installation, or click Back if you want to review or change any settings.
FinishedLabel=Setup has finished installing {#MyAppName} on your computer. The application may be launched by selecting the installed icons.
FinishedLabelNoIcons=Setup has finished installing {#MyAppName} on your computer.
ClickFinish=Click the Finish button to exit Setup.
TaskDesktop=Create a desktop shortcut
TaskAutostart=Auto start SLATE while setup
TaskKeepData=Keep data when uninstall
GroupShortcuts=Additional shortcuts:
GroupOptions=Additional options:
GroupUninstall=Uninstall behavior:
UninstallApp=Uninstall {#MyAppName}
LaunchApp=Launch {#MyAppName}
AppLangTitle=Application Language
AppLangSub=Choose the interface language of SLATE
AppLangFooter=This can be changed by reinstalling.
WebView2Msg=Microsoft Edge WebView2 runtime was not detected.%n%nThe SLATE desktop window depends on it; the UI may fail to display without it.%n%nOpen the official Microsoft download page? (You can also install it later.)
UninstallDataMsg=Delete user data (chat history, custom skills, settings) as well?%n%nChoose ""No"" to keep the data and continue after reinstalling.

chinesesimp.SetupWindowTitle=SLATE 砚 安装程序
chinesesimp.WelcomeLabel1=欢迎使用 {#MyAppName} 安装向导
chinesesimp.WelcomeLabel2=安装程序将把 {#MyAppName} 安装到您的计算机。建议在继续前关闭所有其他应用程序。
chinesesimp.SelectTasksLabel1=请选择安装过程中要执行的其他任务，然后点击“下一步”。
chinesesimp.SelectTasksLabel2=需要执行哪些附加任务？
chinesesimp.ReadyLabel1=准备安装
chinesesimp.ReadyLabel2=点击“安装”开始安装；如需检查或修改设置，请点击“上一步”。
chinesesimp.FinishedLabel=安装程序已成功将 {#MyAppName} 安装到您的计算机，可通过选择安装的图标启动应用程序。
chinesesimp.FinishedLabelNoIcons=安装程序已成功将 {#MyAppName} 安装到您的计算机。
chinesesimp.ClickFinish=点击“完成”按钮退出安装程序。
chinesesimp.TaskDesktop=创建桌面快捷方式
chinesesimp.TaskAutostart=开机自动启动 {#MyAppName}
chinesesimp.TaskKeepData=卸载时保留用户数据（聊天记录 / 技能 / 设置）
chinesesimp.GroupShortcuts=附加快捷方式：
chinesesimp.GroupOptions=附加选项：
chinesesimp.GroupUninstall=卸载行为：
chinesesimp.UninstallApp=卸载 {#MyAppName}
chinesesimp.LaunchApp=启动 {#MyAppName}
chinesesimp.AppLangTitle=应用语言
chinesesimp.AppLangSub=选择 SLATE 的界面语言
chinesesimp.AppLangFooter=安装完成后可通过重装更改。
chinesesimp.WebView2Msg=未检测到 Microsoft Edge WebView2 运行时。%n%nSLATE 桌面窗口依赖该组件，缺少时可能无法显示界面。%n%n是否打开微软官方下载页面？（也可稍后自行安装）
chinesesimp.UninstallDataMsg=是否同时删除用户数据（聊天记录、自定义技能、设置）？%n%n选择“否”将保留数据，重新安装后可继续使用。

[Tasks]
Name: "desktopicon"; Description: "{cm:TaskDesktop}"; GroupDescription: "{cm:GroupShortcuts}"; Flags: checkedonce
Name: "autostart"; Description: "{cm:TaskAutostart}"; GroupDescription: "{cm:GroupOptions}"; Flags: unchecked
Name: "userdata"; Description: "{cm:TaskKeepData}"; GroupDescription: "{cm:GroupUninstall}"; Flags: checkedonce

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
Name: "{group}\{cm:UninstallApp}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent shellexec

[InstallDelete]
; 清理旧版本 PyInstaller 产物，避免残留
Type: filesandordirs; Name: "{app}\_internal"

[UninstallDelete]
Type: files; Name: "{app}\desktop_backend.log"
Type: files; Name: "{app}\*.log"

[Code]
// ── 应用界面语言选择（与安装包语言相互独立，写入 data/language.txt） ──
var
  LangPage: TInputOptionWizardPage;
  LangZhIndex: Integer;
  LangEnIndex: Integer;

procedure InitializeWizard;
begin
  LangPage := CreateInputOptionPage(wpSelectTasks,
    ExpandConstant('{cm:AppLangTitle}'),
    ExpandConstant('{cm:AppLangSub}'),
    ExpandConstant('{cm:AppLangFooter}'),
    True, False);
  LangZhIndex := LangPage.Add('简体中文 (Chinese)');
  LangEnIndex := LangPage.Add('English (英文)');
  // 默认跟随第一步所选的安装包语言，仍可在此页另选
  if ActiveLanguage() = 'chinesesimp' then
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
    if MsgBox(ExpandConstant('{cm:WebView2Msg}'),
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
      if MsgBox(ExpandConstant('{cm:UninstallDataMsg}'),
        mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(ExpandConstant('{app}\data'), True, True, True);
      end;
    end;
  end;
end;
