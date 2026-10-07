; Inno Setup 스크립트: dist/PaperShelf 폴더를 Windows 설치 파일로 만든다.
; iscc /DAppVersion=1.0.0 packaging\papershelf.iss   (papers\ 폴더에서)
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6C1F7E52-6E0B-4C55-9A0B-3B7C2F0D5E11}
AppName=논문 서재
AppVersion={#AppVersion}
AppPublisher=PaperShelf
DefaultDirName={localappdata}\Programs\PaperShelf
DefaultGroupName=논문 서재
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=PaperShelf-Setup-{#AppVersion}
SetupIconFile=..\static\icon.ico
UninstallDisplayIcon={app}\PaperShelf.exe
UninstallDisplayName=논문 서재
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
#ifdef Korean
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "Windows 시작할 때 자동 실행 (알림 영역에 대기)"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\PaperShelf\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\논문 서재"; Filename: "{app}\PaperShelf.exe"
Name: "{group}\논문 서재 제거"; Filename: "{uninstallexe}"
Name: "{autodesktop}\논문 서재"; Filename: "{app}\PaperShelf.exe"; Tasks: desktopicon
Name: "{userstartup}\논문 서재"; Filename: "{app}\PaperShelf.exe"; Parameters: "--no-browser"; Tasks: autostart

[Run]
Filename: "{app}\PaperShelf.exe"; Description: "{cm:LaunchProgram,논문 서재}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /IM PaperShelf.exe /F"; Flags: runhidden; RunOnceId: "KillApp"
