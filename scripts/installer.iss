#ifndef Payload
  #error Payload directory must be passed with /DPayload
#endif
#ifndef Destination
  #error Output directory must be passed with /DDestination
#endif

[Setup]
AppId=ChatScope.Desktop
AppName=ChatScope
AppVersion=0.2.0
AppVerName=ChatScope 0.2.0
AppPublisher=wyykkk-sudo
AppPublisherURL=https://github.com/wyykkk-sudo/ChatScope
AppSupportURL=https://github.com/wyykkk-sudo/ChatScope/issues
AppUpdatesURL=https://github.com/wyykkk-sudo/ChatScope/releases
DefaultDirName={localappdata}\Programs\ChatScope
DefaultGroupName=ChatScope
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
WizardSizePercent=110
DisableWelcomePage=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
OutputDir={#Destination}
OutputBaseFilename=ChatScope-Setup-0.2.0-x64
Compression=lzma2/fast
SolidCompression=yes
UninstallDisplayName=ChatScope
UninstallDisplayIcon={app}\ChatScope.exe
SetupIconFile={#Payload}\chatscope.ico
CloseApplications=yes
RestartApplications=no
CreateUninstallRegKey=not IsQATest
UsePreviousAppDir=not IsQATest
UsePreviousTasks=not IsQATest
VersionInfoVersion=0.2.0.0
VersionInfoCompany=wyykkk-sudo
VersionInfoDescription=ChatScope 微信聊天分析安装程序
VersionInfoProductName=ChatScope
VersionInfoProductVersion=0.2.0

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\ChatScope\ChatScope"; Filename: "{app}\ChatScope.exe"; WorkingDir: "{app}"; IconFilename: "{app}\chatscope.ico"; Check: not IsQATest
Name: "{userdesktop}\ChatScope"; Filename: "{app}\ChatScope.exe"; WorkingDir: "{app}"; IconFilename: "{app}\chatscope.ico"; Tasks: desktopicon; Check: not IsQATest

[Run]
Filename: "{app}\ChatScope.exe"; Description: "启动 ChatScope"; Flags: nowait postinstall skipifsilent; Check: not IsQATest

[Code]
function IsQATest: Boolean;
begin
  Result := ExpandConstant('{param:QAINSTALL|0}') = '1';
end;
