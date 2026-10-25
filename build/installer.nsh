!ifndef MUI_BGCOLOR
  !define MUI_BGCOLOR "FFFFFF"
!endif
!ifndef MUI_TEXTCOLOR
  !define MUI_TEXTCOLOR "111217"
!endif
!ifndef MUI_DIRECTORYPAGE_BGCOLOR
  !define MUI_DIRECTORYPAGE_BGCOLOR "FFFFFF"
!endif
!ifndef MUI_DIRECTORYPAGE_TEXTCOLOR
  !define MUI_DIRECTORYPAGE_TEXTCOLOR "111217"
!endif
!ifndef MUI_INSTFILESPAGE_COLORS
  !define MUI_INSTFILESPAGE_COLORS "3257F7 FFFFFF"
!endif
!ifndef MUI_FINISHPAGE_LINK_COLOR
  !define MUI_FINISHPAGE_LINK_COLOR "3257F7"
!endif
!ifndef MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE
!endif
!ifndef MUI_HEADERIMAGE_BITMAP_STRETCH
  !define MUI_HEADERIMAGE_BITMAP_STRETCH "FitControl"
!endif
!ifndef MUI_HEADERIMAGE_UNBITMAP_STRETCH
  !define MUI_HEADERIMAGE_UNBITMAP_STRETCH "FitControl"
!endif
!ifndef BUILD_UNINSTALLER
  !ifndef MUI_CUSTOMFUNCTION_GUIINIT
    !define MUI_CUSTOMFUNCTION_GUIINIT MineradioGuiInit
  !endif
!endif

!include LogicLib.nsh
!include FileFunc.nsh
!include StdUtils.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!ifndef MINERADIO_INSTALL_DIR_NAME
  !define MINERADIO_INSTALL_DIR_NAME "Mineradio"
!endif
!ifndef MINERADIO_INSTALL_DIR_NAME_LOWER
  !define MINERADIO_INSTALL_DIR_NAME_LOWER "mineradio"
!endif
!ifndef MINERADIO_INSTALL_MARKER
  !define MINERADIO_INSTALL_MARKER ".mineradio-install-root"
!endif
!ifndef MINERADIO_MARKER_APP_ID
  !define MINERADIO_MARKER_APP_ID "com.mineradio.desktop"
!endif
!ifndef MINERADIO_INSTALL_BRAND
  !define MINERADIO_INSTALL_BRAND "MINERADIO"
!endif
!ifndef MINERADIO_INSTALL_TITLE
  !define MINERADIO_INSTALL_TITLE "Mineradio 安装"
!endif
!ifndef MINERADIO_INSTALL_NOTICE
  !define MINERADIO_INSTALL_NOTICE ""
!endif

; 第一步的界面语言选择：安装器把选中的语言码写进 resources/app/userdata/ 里的标记文件，
; 应用首次启动时读一次就删掉，用作「还没有存过偏好」时的默认语言。
; The welcome page's language picker drops the chosen code into a marker file under
; resources/app/userdata/. The app reads it once on first launch and deletes it, using it as
; the default language while no explicit preference has been saved yet.
!ifndef MINERADIO_LANG_MARKER
  !define MINERADIO_LANG_MARKER ".installer-language"
!endif
!ifndef MINERADIO_LANG_DEFAULT
  !define MINERADIO_LANG_DEFAULT "zh_cn"
!endif
; 欢迎页纵向空间只有 140 个对话框单位：灰度内测版多一段红色声明，语言行就得整体下移。
; The welcome page is only 140 dialog units tall; the internal-beta build adds a red notice,
; so its language row has to sit lower.
!ifdef MINERADIO_INTERNAL_BETA
  !define MINERADIO_LANG_CAPTION_Y 112
  !define MINERADIO_LANG_ROW_Y 124
!else
  !define MINERADIO_LANG_CAPTION_Y 104
  !define MINERADIO_LANG_ROW_Y 118
!endif

!ifndef BUILD_UNINSTALLER
  Var MineradioWelcomePage
  Var MineradioHeroFont
  Var MineradioTitleFont
  Var MineradioBodyFont
  Var MineradioSmallFont
  Var MineradioDirectoryPage
  Var MineradioDirectoryInput
  Var MineradioLanguage
  Var MineradioLangRadioZh
  Var MineradioLangRadioEn
  Var MineradioLangRadioJa
  Var MineradioLangRadioRu
!endif

!macro customInit
  !ifndef BUILD_UNINSTALLER
    Call MineradioUsePreferredInstallDir
    Call MineradioDisableUnsafeOldUninstallers
    Call MineradioResolveLanguage
    ${If} ${Silent}
      Call MineradioValidateInstallDir
    ${EndIf}
  !endif
!macroend

!macro customInstall
  FileOpen $0 "$INSTDIR\${MINERADIO_INSTALL_MARKER}" w
  ${IfNot} ${Errors}
    FileWrite $0 "Mineradio install root$\r$\n"
    FileWrite $0 "appId=${MINERADIO_MARKER_APP_ID}$\r$\n"
    FileClose $0
  ${EndIf}

  ; 只有走过第一步选语言（非静默安装）才写：静默安装/更新时没有界面，不该改写旧选择。
  ; Only write when the language step actually ran (interactive install): silent installs and
  ; updates show no page and must not overwrite an earlier choice.
  ${If} $MineradioLanguage != ""
    CreateDirectory "$INSTDIR\resources\app\userdata"
    FileOpen $0 "$INSTDIR\resources\app\userdata\${MINERADIO_LANG_MARKER}" w
    ${IfNot} ${Errors}
      FileWrite $0 "$MineradioLanguage$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
!macroend

!macro customRemoveFiles
  Call un.MineradioRemoveInstalledFiles
!macroend

!macro customWelcomePage
  Page custom MineradioWelcomeShow MineradioWelcomeLeave
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customPageAfterChangeDir
  Page custom MineradioDirectoryShow MineradioDirectoryLeave
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function MineradioFinishStartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "MineradioFinishStartApp"
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW MineradioTintCommonControls
  !insertmacro MUI_PAGE_FINISH
!macroend

!ifndef BUILD_UNINSTALLER
Function MineradioGuiInit
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i .r0'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4) i .r0'
  Call MineradioTintCommonControls
FunctionEnd

Function MineradioTintCommonControls
  SetCtlColors $HWNDPARENT "111217" "FFFFFF"

  GetDlgItem $0 $HWNDPARENT 1
  ${If} $0 <> 0
    SetCtlColors $0 "111217" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 2
  ${If} $0 <> 0
    SetCtlColors $0 "111217" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 3
  ${If} $0 <> 0
    SetCtlColors $0 "111217" "FFFFFF"
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1028
  ${If} $0 <> 0
    SetCtlColors $0 "4B5263" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1256
  ${If} $0 <> 0
    SetCtlColors $0 "4B5263" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1034
  ${If} $0 <> 0
    SetCtlColors $0 "" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1035
  ${If} $0 <> 0
    SetCtlColors $0 "" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1037
  ${If} $0 <> 0
    SetCtlColors $0 "111217" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1038
  ${If} $0 <> 0
    SetCtlColors $0 "4B5263" "FFFFFF"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1039
  ${If} $0 <> 0
    SetCtlColors $0 "" "FFFFFF"
  ${EndIf}

  FindWindow $0 "#32770" "" $HWNDPARENT
  ${If} $0 <> 0
    SetCtlColors $0 "111217" "FFFFFF"

    GetDlgItem $1 $0 1000
    ${If} $1 <> 0
      SetCtlColors $1 "111217" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1001
    ${If} $1 <> 0
      SetCtlColors $1 "111217" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1004
    ${If} $1 <> 0
      SetCtlColors $1 "3257F7" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1006
    ${If} $1 <> 0
      SetCtlColors $1 "4B5263" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1016
    ${If} $1 <> 0
      SetCtlColors $1 "4B5263" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1019
    ${If} $1 <> 0
      SetCtlColors $1 "111217" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1020
    ${If} $1 <> 0
      SetCtlColors $1 "4B5263" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1023
    ${If} $1 <> 0
      SetCtlColors $1 "4B5263" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1024
    ${If} $1 <> 0
      SetCtlColors $1 "4B5263" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1027
    ${If} $1 <> 0
      SetCtlColors $1 "111217" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1201
    ${If} $1 <> 0
      SetCtlColors $1 "111217" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1202
    ${If} $1 <> 0
      SetCtlColors $1 "4B5263" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1203
    ${If} $1 <> 0
      SetCtlColors $1 "111217" "FFFFFF"
    ${EndIf}
    GetDlgItem $1 $0 1204
    ${If} $1 <> 0
      SetCtlColors $1 "4B5263" "FFFFFF"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function MineradioUsePreferredInstallDir
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/D=" $R1
  ${IfNot} ${Errors}
  ${AndIf} $R1 != ""
    StrCpy $INSTDIR "$R1"
  ${Else}
    Call MineradioUseRegisteredInstallDir
    Pop $R2
    ${If} $R2 != "1"
      Call MineradioUseFirstAvailableInstallDir
    ${EndIf}
  ${EndIf}
  Push "$INSTDIR"
  Call MineradioNormalizeInstallDir
  Pop $INSTDIR
FunctionEnd

; ---------------------------------------------------------------------------
; 本地固定磁盘判定
;
; 原来用 IfFileExists "X:\*.*" 判断某个分区能不能装，而它只看「该盘根目录下有没有文件」：
; 真正的空 D 盘会被判成"不存在"，而映射的网络盘 / 光驱 / 读卡器只要根目录有东西就被当
; 成"本地区"，只有 C 盘但插了 U 盘的电脑会被误判成"还有别的分区"从而拒绝安装到 C 盘。
; 这里改为问内核真实的驱动器类型，只认 DRIVE_FIXED(3)。
; 中英对照：The drive scan used IfFileExists "X:\*.*", which only reports whether the drive
; root contains any file: a genuinely empty local D: looked missing, while mapped network
; drives, optical drives and card readers counted as local partitions. Ask the kernel for the
; real drive type and accept DRIVE_FIXED (3) only.
!ifndef MINERADIO_DRIVE_FIXED
  !define MINERADIO_DRIVE_FIXED 3
!endif

Function MineradioDriveLetterIsFixed
  ; 入参：栈上压入单个大写盘符（如 "D"）；返回：栈上压入 "1"/"0"
  Exch $0
  System::Call 'kernel32::GetDriveTypeW(w "$0:\\") i .r1'
  ${If} $1 == ${MINERADIO_DRIVE_FIXED}
    StrCpy $1 "1"
  ${Else}
    StrCpy $1 "0"
  ${EndIf}
  StrCpy $0 "$1"
  Exch $0
FunctionEnd

Function MineradioFirstFixedDriveLetter
  ; 返回：栈上压入第一个可用的本地固定盘符（D..Z），没有则压入空串。
  ; 空串表示"这台电脑只有 C 盘"，调用方据此落回 C:\Mineradio。
  ; 只用 $R 寄存器保存循环状态：被调用的 MineradioDriveLetterIsFixed 会占用 $0 / $1。
  StrCpy $R0 "DEFGHIJKLMNOPQRSTUVWXYZ"

  driveLoop:
    StrCmp $R0 "" driveLoopEnd
    StrCpy $R1 "$R0" 1 0
    StrCpy $R0 "$R0" 64 1
    Push $R1
    Call MineradioDriveLetterIsFixed
    Pop $R3
    ${If} $R3 == "1"
      Push "$R1"
      Return
    ${EndIf}
    Goto driveLoop

  driveLoopEnd:
    Push ""
FunctionEnd

Function MineradioUseFirstAvailableInstallDir
  Call MineradioFirstFixedDriveLetter
  Pop $0
  ${If} $0 == ""
    StrCpy $INSTDIR "C:\${MINERADIO_INSTALL_DIR_NAME}"
  ${Else}
    StrCpy $INSTDIR "$0:\${MINERADIO_INSTALL_DIR_NAME}"
  ${EndIf}
FunctionEnd

Function MineradioHasPreferredInstallDrive
  ; 返回 "1" 表示存在可用的非 C 本地固定盘，"0" 表示只有 C 盘（此时 C 盘安装放行）。
  Call MineradioFirstFixedDriveLetter
  Pop $0
  ${If} $0 == ""
    Push "0"
  ${Else}
    Push "1"
  ${EndIf}
FunctionEnd

Function MineradioNormalizeInstallDir
  Exch $0
  Push "$0"
  Call MineradioTrimInstallDir
  Pop $0
  StrLen $4 "${MINERADIO_INSTALL_DIR_NAME}"
  StrLen $1 "$0"
  ${If} $1 == 2
    StrCpy $2 "$0" 1 1
    ${If} $2 == ":"
      StrCpy $0 "$0\${MINERADIO_INSTALL_DIR_NAME}"
    ${EndIf}
  ${ElseIf} $1 == 3
    StrCpy $2 "$0" 1 1
    StrCpy $3 "$0" 1 2
    ${If} $2 == ":"
    ${AndIf} $3 == "\"
      StrCpy $0 "$0${MINERADIO_INSTALL_DIR_NAME}"
    ${EndIf}
  ${EndIf}

  StrLen $1 "$0"
  IntOp $5 $4 + 1
  StrCpy $2 "$0" $5 -$5
  ${If} $1 < $5
  ${OrIf} $2 != "\${MINERADIO_INSTALL_DIR_NAME}"
  ${AndIf} $2 != "\${MINERADIO_INSTALL_DIR_NAME_LOWER}"
    StrCpy $0 "$0\${MINERADIO_INSTALL_DIR_NAME}"
  ${EndIf}
  Exch $0
FunctionEnd

Function MineradioTrimInstallDir
  Exch $0

  trim:
    StrLen $1 "$0"
    ${If} $1 > 3
      StrCpy $2 "$0" 1 -1
      ${If} $2 == "\"
        StrCpy $0 "$0" -1
        Goto trim
      ${EndIf}
    ${EndIf}

  Exch $0
FunctionEnd

Function MineradioInstallDirLooksOwned
  Exch $0
  StrCpy $1 "0"

  IfFileExists "$0\${MINERADIO_INSTALL_MARKER}" 0 +2
    StrCpy $1 "1"

  StrCpy $0 "$1"
  Exch $0
FunctionEnd

Function MineradioExistingInstallPathCanBeAdopted
  Exch $0
  StrCpy $1 "0"

  ${If} $0 == ""
    Goto done
  ${EndIf}

  Push "$0"
  Call MineradioTrimInstallDir
  Pop $2
  ${If} $2 == ""
    Goto done
  ${EndIf}

  Push "$2"
  Call MineradioNormalizeInstallDir
  Pop $3
  ${If} $2 != $3
    Goto done
  ${EndIf}

  IfFileExists "$2\*.*" 0 done
  IfFileExists "$2\${MINERADIO_INSTALL_MARKER}" adopt 0
  IfFileExists "$2\${PRODUCT_FILENAME}.exe" adopt 0
  IfFileExists "$2\resources\app.asar" adopt 0
  IfFileExists "$2\resources\app\package.json" adopt 0
  IfFileExists "$2\resources\app\server\server.js" adopt 0
  Goto done

  adopt:
    StrCpy $1 "1"

  done:
    StrCpy $0 "$1"
    Exch $0
FunctionEnd

Function MineradioUseRegisteredInstallDir
  ReadRegStr $0 HKCU "Software\${APP_GUID}" InstallLocation
  Push "$0"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $1
  ${If} $1 == "1"
    Push "$0"
    Call MineradioNormalizeInstallDir
    Pop $INSTDIR
    Push "1"
    Return
  ${EndIf}

  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" InstallLocation
  Push "$0"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $1
  ${If} $1 == "1"
    Push "$0"
    Call MineradioNormalizeInstallDir
    Pop $INSTDIR
    Push "1"
    Return
  ${EndIf}

  ReadRegStr $0 HKLM "Software\${APP_GUID}" InstallLocation
  Push "$0"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $1
  ${If} $1 == "1"
    Push "$0"
    Call MineradioNormalizeInstallDir
    Pop $INSTDIR
    Push "1"
    Return
  ${EndIf}

  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" InstallLocation
  Push "$0"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $1
  ${If} $1 == "1"
    Push "$0"
    Call MineradioNormalizeInstallDir
    Pop $INSTDIR
    Push "1"
    Return
  ${EndIf}

  Push "0"
FunctionEnd

Function MineradioRegisteredInstallDirCanBeAdopted
  Exch $0
  StrCpy $1 "0"

  ${If} $0 == ""
    Goto done
  ${EndIf}

  Push "$0"
  Call MineradioNormalizeInstallDir
  Pop $2

  ReadRegStr $3 HKCU "Software\${APP_GUID}" InstallLocation
  Push "$3"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $4
  ${If} $4 == "1"
    Push "$3"
    Call MineradioNormalizeInstallDir
    Pop $5
    ${If} $5 == $2
      StrCpy $1 "1"
      Goto done
    ${EndIf}
  ${EndIf}

  ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" InstallLocation
  Push "$3"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $4
  ${If} $4 == "1"
    Push "$3"
    Call MineradioNormalizeInstallDir
    Pop $5
    ${If} $5 == $2
      StrCpy $1 "1"
      Goto done
    ${EndIf}
  ${EndIf}

  ReadRegStr $3 HKLM "Software\${APP_GUID}" InstallLocation
  Push "$3"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $4
  ${If} $4 == "1"
    Push "$3"
    Call MineradioNormalizeInstallDir
    Pop $5
    ${If} $5 == $2
      StrCpy $1 "1"
      Goto done
    ${EndIf}
  ${EndIf}

  ReadRegStr $3 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" InstallLocation
  Push "$3"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $4
  ${If} $4 == "1"
    Push "$3"
    Call MineradioNormalizeInstallDir
    Pop $5
    ${If} $5 == $2
      StrCpy $1 "1"
      Goto done
    ${EndIf}
  ${EndIf}

  done:
    StrCpy $0 "$1"
    Exch $0
FunctionEnd

Function MineradioInstallDirIsEmpty
  Exch $0
  FindFirst $1 $2 "$0\*.*"
  StrCpy $3 "1"

  loop:
    StrCmp $2 "" done
    StrCmp $2 "." next
    StrCmp $2 ".." next
    StrCpy $3 "0"
    Goto done

  next:
    FindNext $1 $2
    Goto loop

  done:
    FindClose $1
    StrCpy $0 "$3"
    Exch $0
FunctionEnd

Function MineradioOldInstallPathNeedsQuarantine
  Exch $0
  StrCpy $1 "0"

  ${If} $0 == ""
    Goto done
  ${EndIf}

  Push "$0"
  Call MineradioTrimInstallDir
  Pop $2
  Push "$2"
  Call MineradioNormalizeInstallDir
  Pop $3

  ${If} $2 != $3
    StrCpy $1 "1"
    Goto done
  ${EndIf}

  IfFileExists "$2\${MINERADIO_INSTALL_MARKER}" done 0
  Push "$2"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $4
  ${If} $4 == "1"
    Goto done
  ${EndIf}

  StrCpy $1 "1"

  done:
    StrCpy $0 "$1"
    Exch $0
FunctionEnd

Function MineradioDisableUnsafeOldUninstallers
  StrCpy $2 "0"

  ReadRegStr $0 HKCU "Software\${APP_GUID}" InstallLocation
  Push "$0"
  Call MineradioDeleteLegacyUninstallerFileIfMissingMarker
  Push "$0"
  Call MineradioOldInstallPathNeedsQuarantine
  Pop $1
  ${If} $1 == "1"
    DetailPrint "Skip unsafe legacy Mineradio uninstaller: $0"
    StrCpy $2 "1"
  ${EndIf}

  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" InstallLocation
  Push "$0"
  Call MineradioDeleteLegacyUninstallerFileIfMissingMarker
  Push "$0"
  Call MineradioOldInstallPathNeedsQuarantine
  Pop $1
  ${If} $1 == "1"
    DetailPrint "Skip unsafe legacy Mineradio uninstaller: $0"
    StrCpy $2 "1"
  ${EndIf}

  ${If} $2 == "1"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
    DeleteRegKey HKCU "Software\${APP_GUID}"
  ${EndIf}

  StrCpy $2 "0"

  ReadRegStr $0 HKLM "Software\${APP_GUID}" InstallLocation
  Push "$0"
  Call MineradioDeleteLegacyUninstallerFileIfMissingMarker
  Push "$0"
  Call MineradioOldInstallPathNeedsQuarantine
  Pop $1
  ${If} $1 == "1"
    DetailPrint "Skip unsafe legacy Mineradio uninstaller: $0"
    StrCpy $2 "1"
  ${EndIf}

  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" InstallLocation
  Push "$0"
  Call MineradioDeleteLegacyUninstallerFileIfMissingMarker
  Push "$0"
  Call MineradioOldInstallPathNeedsQuarantine
  Pop $1
  ${If} $1 == "1"
    DetailPrint "Skip unsafe legacy Mineradio uninstaller: $0"
    StrCpy $2 "1"
  ${EndIf}

  ${If} $2 == "1"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
    DeleteRegKey HKLM "Software\${APP_GUID}"
  ${EndIf}
FunctionEnd

Function MineradioDeleteLegacyUninstallerFileIfMissingMarker
  Pop $0
  ${If} $0 != ""
    Push "$0"
    Call MineradioTrimInstallDir
    Pop $1
    ${If} $1 != ""
      IfFileExists "$1\${MINERADIO_INSTALL_MARKER}" done 0
      DetailPrint "Remove legacy Mineradio uninstaller file: $1"
      Delete "$1\Uninstall ${PRODUCT_FILENAME}.exe"
    ${EndIf}
  ${EndIf}

  done:
FunctionEnd

Function MineradioValidateInstallDir
  Push "$INSTDIR"
  Call MineradioNormalizeInstallDir
  Pop $INSTDIR

  Push "$INSTDIR"
  Call MineradioRegisteredInstallDirCanBeAdopted
  Pop $3

  Push "$INSTDIR"
  Call MineradioExistingInstallPathCanBeAdopted
  Pop $4

  StrCpy $0 "$INSTDIR" 1 0
  StrCpy $1 "$INSTDIR" 1 1
  ${If} $1 == ":"
    ${If} $0 == "C"
    ${OrIf} $0 == "c"
      Call MineradioHasPreferredInstallDrive
      Pop $2
      ${If} $2 == "1"
      ${AndIf} $3 != "1"
      ${AndIf} $4 != "1"
        MessageBox MB_ICONSTOP|MB_OK "检测到这台电脑还有 D-Z 盘，Mineradio 不安装到 C 盘。请改选 D 盘或其它非 C 盘的 Mineradio 文件夹。$\r$\n$\r$\n如果电脑只有 C 盘，安装器会自动放行 C:\Mineradio。"
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}

  StrLen $0 "$INSTDIR"
  StrLen $2 "${MINERADIO_INSTALL_DIR_NAME}"
  IntOp $2 $2 + 1
  StrCpy $1 "$INSTDIR" $2 -$2
  ${If} $0 < $2
  ${OrIf} $1 != "\${MINERADIO_INSTALL_DIR_NAME}"
  ${AndIf} $1 != "\${MINERADIO_INSTALL_DIR_NAME_LOWER}"
    MessageBox MB_ICONSTOP|MB_OK "安装目录必须是独立的 Mineradio 文件夹。请选择一个上级目录，安装器会自动创建 Mineradio 子文件夹。"
    Abort
  ${EndIf}

  IfFileExists "$INSTDIR\*.*" 0 valid

  Push "$INSTDIR"
  Call MineradioInstallDirLooksOwned
  Pop $0
  ${If} $0 == "1"
    Goto valid
  ${EndIf}

  ${If} $3 == "1"
    Goto valid
  ${EndIf}

  ${If} $4 == "1"
    Goto valid
  ${EndIf}

  Push "$INSTDIR"
  Call MineradioInstallDirIsEmpty
  Pop $0
  ${If} $0 == "1"
    Goto valid
  ${EndIf}

  MessageBox MB_ICONSTOP|MB_OK "为避免卸载时误删其它文件，Mineradio 不能安装到已有文件的非专属目录。请新建或选择一个空的 Mineradio 文件夹。$\r$\n$\r$\n当前路径：$INSTDIR"
  Abort

  valid:
FunctionEnd
Function MineradioResolveLanguage
  ; 默认值 → /APP_LANG= 覆盖 → 静默安装清空（不写标记）。
  ; Default, then an /APP_LANG= override, then blank for silent installs (no marker written).
  StrCpy $MineradioLanguage "${MINERADIO_LANG_DEFAULT}"

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/APP_LANG=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "en_us"
    ${OrIf} $R1 == "ja_jp"
    ${OrIf} $R1 == "ru_ru"
      StrCpy $MineradioLanguage "$R1"
    ${EndIf}
  ${EndIf}

  ${If} ${Silent}
    StrCpy $MineradioLanguage ""
  ${EndIf}
FunctionEnd

Function MineradioWelcomeShow
  Call MineradioUsePreferredInstallDir

  nsDialogs::Create 1018
  Pop $MineradioWelcomePage
  ${If} $MineradioWelcomePage == error
    Abort
  ${EndIf}

  SetCtlColors $MineradioWelcomePage "111217" "FFFFFF"
  CreateFont $MineradioHeroFont "Microsoft YaHei UI" 20 700
  CreateFont $MineradioTitleFont "Microsoft YaHei UI" 9 700
  CreateFont $MineradioBodyFont "Microsoft YaHei UI" 9 400
  CreateFont $MineradioSmallFont "Microsoft YaHei UI" 8 400

  ${NSD_CreateLabel} 22u 14u 120u 10u "${MINERADIO_INSTALL_BRAND}"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioSmallFont 1
  SetCtlColors $0 "3257F7" "FFFFFF"

  ${NSD_CreateLabel} 22u 28u 226u 26u "${MINERADIO_INSTALL_TITLE}"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioHeroFont 1
  SetCtlColors $0 "111217" "FFFFFF"

  ${NSD_CreateLabel} 22u 58u 32u 2u ""
  Pop $0
  SetCtlColors $0 "" "3257F7"

  ${NSD_CreateLabel} 22u 66u 238u 24u "为这台电脑安装 ${PRODUCT_NAME}。默认位置：$INSTDIR，下一步可以自由选择其它位置。"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioBodyFont 1
  SetCtlColors $0 "4B5263" "FFFFFF"

  !ifdef MINERADIO_INTERNAL_BETA
    ${NSD_CreateLabel} 22u 86u 238u 20u "${MINERADIO_INSTALL_NOTICE}"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $MineradioSmallFont 1
    SetCtlColors $0 "B42318" "FFFFFF"
  !endif

  ${NSD_CreateLabel} 22u ${MINERADIO_LANG_CAPTION_Y}u 238u 10u "语言 / Language"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioTitleFont 1
  SetCtlColors $0 "3257F7" "FFFFFF"

  ; 四个语言按钮用各自的自称，任何语言的用户都能一眼认出自己那一项。
  ; Each option is labelled with its own endonym so any user recognises their own language.
  ${NSD_CreateRadioButton} 22u ${MINERADIO_LANG_ROW_Y}u 40u 12u "中文"
  Pop $MineradioLangRadioZh
  SendMessage $MineradioLangRadioZh ${WM_SETFONT} $MineradioBodyFont 1
  SetCtlColors $MineradioLangRadioZh "111217" "FFFFFF"

  ${NSD_CreateRadioButton} 66u ${MINERADIO_LANG_ROW_Y}u 52u 12u "English"
  Pop $MineradioLangRadioEn
  SendMessage $MineradioLangRadioEn ${WM_SETFONT} $MineradioBodyFont 1
  SetCtlColors $MineradioLangRadioEn "111217" "FFFFFF"

  ${NSD_CreateRadioButton} 122u ${MINERADIO_LANG_ROW_Y}u 42u 12u "日本語"
  Pop $MineradioLangRadioJa
  SendMessage $MineradioLangRadioJa ${WM_SETFONT} $MineradioBodyFont 1
  SetCtlColors $MineradioLangRadioJa "111217" "FFFFFF"

  ${NSD_CreateRadioButton} 168u ${MINERADIO_LANG_ROW_Y}u 54u 12u "Русский"
  Pop $MineradioLangRadioRu
  SendMessage $MineradioLangRadioRu ${WM_SETFONT} $MineradioBodyFont 1
  SetCtlColors $MineradioLangRadioRu "111217" "FFFFFF"

  ${If} $MineradioLanguage == "en_us"
    ${NSD_SetState} $MineradioLangRadioEn ${BST_CHECKED}
  ${ElseIf} $MineradioLanguage == "ja_jp"
    ${NSD_SetState} $MineradioLangRadioJa ${BST_CHECKED}
  ${ElseIf} $MineradioLanguage == "ru_ru"
    ${NSD_SetState} $MineradioLangRadioRu ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $MineradioLangRadioZh ${BST_CHECKED}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function MineradioWelcomeLeave
  ; 读回选中项而不是靠点击回调：方向键也能换选项，不经过点击。
  ; Read the state back instead of tracking clicks: arrow keys change the selection too.
  ${NSD_GetState} $MineradioLangRadioZh $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MineradioLanguage "zh_cn"
  ${EndIf}
  ${NSD_GetState} $MineradioLangRadioEn $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MineradioLanguage "en_us"
  ${EndIf}
  ${NSD_GetState} $MineradioLangRadioJa $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MineradioLanguage "ja_jp"
  ${EndIf}
  ${NSD_GetState} $MineradioLangRadioRu $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MineradioLanguage "ru_ru"
  ${EndIf}
FunctionEnd

Function MineradioDirectoryBrowse
  nsDialogs::SelectFolderDialog "选择 ${PRODUCT_NAME} 安装文件夹" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    Push "$0"
    Call MineradioNormalizeInstallDir
    Pop $0
    StrCpy $INSTDIR "$0"
    SendMessage $MineradioDirectoryInput ${WM_SETTEXT} 0 "STR:$INSTDIR"
  ${EndIf}
FunctionEnd

Function MineradioDirectoryShow
  Call MineradioUsePreferredInstallDir

  nsDialogs::Create 1018
  Pop $MineradioDirectoryPage
  ${If} $MineradioDirectoryPage == error
    Abort
  ${EndIf}

  SetCtlColors $MineradioDirectoryPage "111217" "FFFFFF"
  CreateFont $MineradioTitleFont "Microsoft YaHei UI" 15 700
  CreateFont $MineradioBodyFont "Microsoft YaHei UI" 9 400
  CreateFont $MineradioSmallFont "Microsoft YaHei UI" 8 500

  ${NSD_CreateLabel} 22u 12u 238u 20u "选择安装位置"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioTitleFont 1
  SetCtlColors $0 "111217" "FFFFFF"

  ${NSD_CreateLabel} 22u 40u 238u 24u "你可以使用默认路径，也可以选择其它磁盘或文件夹。安装器会自动创建缺失的目录。"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioBodyFont 1
  SetCtlColors $0 "4B5263" "FFFFFF"

  ${NSD_CreateLabel} 22u 76u 238u 10u "安装目录"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioSmallFont 1
  SetCtlColors $0 "3257F7" "FFFFFF"

  ${NSD_CreateText} 22u 94u 178u 15u "$INSTDIR"
  Pop $MineradioDirectoryInput
  SendMessage $MineradioDirectoryInput ${WM_SETFONT} $MineradioBodyFont 1
  SetCtlColors $MineradioDirectoryInput "111217" "FFFFFF"

  ${NSD_CreateBrowseButton} 210u 93u 50u 17u "浏览..."
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioSmallFont 1
  ${NSD_OnClick} $0 MineradioDirectoryBrowse

  ${NSD_CreateLabel} 22u 122u 238u 12u "默认推荐：D:\${MINERADIO_INSTALL_DIR_NAME}；选盘符会自动建文件夹。"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $MineradioSmallFont 1
  SetCtlColors $0 "6B7280" "FFFFFF"

  nsDialogs::Show
FunctionEnd

Function MineradioDirectoryLeave
  ${NSD_GetText} $MineradioDirectoryInput $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "请选择安装文件夹。"
    Abort
  ${EndIf}
  Push "$0"
  Call MineradioNormalizeInstallDir
  Pop $0
  StrCpy $INSTDIR "$0"
  SendMessage $MineradioDirectoryInput ${WM_SETTEXT} 0 "STR:$INSTDIR"
  Call MineradioValidateInstallDir
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
!macro customUnInit
  Call un.MineradioValidateUninstallDir
!macroend

Function un.MineradioInstallDirLooksOwned
  Exch $0
  StrCpy $1 "0"

  IfFileExists "$0\${MINERADIO_INSTALL_MARKER}" 0 +2
    StrCpy $1 "1"

  StrCpy $0 "$1"
  Exch $0
FunctionEnd

Function un.MineradioNormalizeInstallDir
  Exch $0
  Push "$0"
  Call un.MineradioTrimInstallDir
  Pop $0
  StrLen $4 "${MINERADIO_INSTALL_DIR_NAME}"
  StrLen $1 "$0"
  ${If} $1 == 2
    StrCpy $2 "$0" 1 1
    ${If} $2 == ":"
      StrCpy $0 "$0\${MINERADIO_INSTALL_DIR_NAME}"
    ${EndIf}
  ${ElseIf} $1 == 3
    StrCpy $2 "$0" 1 1
    StrCpy $3 "$0" 1 2
    ${If} $2 == ":"
    ${AndIf} $3 == "\"
      StrCpy $0 "$0${MINERADIO_INSTALL_DIR_NAME}"
    ${EndIf}
  ${EndIf}

  StrLen $1 "$0"
  IntOp $5 $4 + 1
  StrCpy $2 "$0" $5 -$5
  ${If} $1 < $5
  ${OrIf} $2 != "\${MINERADIO_INSTALL_DIR_NAME}"
  ${AndIf} $2 != "\${MINERADIO_INSTALL_DIR_NAME_LOWER}"
    StrCpy $0 "$0\${MINERADIO_INSTALL_DIR_NAME}"
  ${EndIf}
  Exch $0
FunctionEnd

Function un.MineradioTrimInstallDir
  Exch $0

  trim:
    StrLen $1 "$0"
    ${If} $1 > 3
      StrCpy $2 "$0" 1 -1
      ${If} $2 == "\"
        StrCpy $0 "$0" -1
        Goto trim
      ${EndIf}
    ${EndIf}

  Exch $0
FunctionEnd

Function un.MineradioValidateUninstallDir
  Push "$INSTDIR"
  Call un.MineradioTrimInstallDir
  Pop $0
  Push "$0"
  Call un.MineradioNormalizeInstallDir
  Pop $1
  ${If} $0 != $1
    MessageBox MB_OK|MB_ICONSTOP "当前卸载路径不是 Mineradio 专属目录，已阻止卸载以避免误删其它文件。$\r$\n$\r$\n当前路径：$INSTDIR$\r$\n安全路径应为：$0"
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $INSTDIR "$0"

  Push "$INSTDIR"
  Call un.MineradioInstallDirLooksOwned
  Pop $0
  ${If} $0 != "1"
    MessageBox MB_OK|MB_ICONSTOP "无法确认当前目录属于 Mineradio，已阻止卸载以避免误删其它文件。$\r$\n$\r$\n当前路径：$INSTDIR"
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function un.MineradioRemoveInstalledFiles
  SetOutPath $TEMP

  Delete "$INSTDIR\${PRODUCT_FILENAME}.exe"
  Delete "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"
  Delete "$INSTDIR\uninstallerIcon.ico"

  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"

  RMDir "$INSTDIR\locales"
  RMDir "$INSTDIR\resources"
  RMDir "$INSTDIR\swiftshader"

  RMDir "$INSTDIR"
FunctionEnd
!endif
