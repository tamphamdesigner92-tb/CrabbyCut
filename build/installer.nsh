; MÓC VÀO BỘ CÀI NSIS DO electron-builder SINH RA.
;
; `customInstall` chạy SAU khi toàn bộ tệp của app đã được chép vào $INSTDIR, nên ở đây đã
; có CrabbyCut.exe để gọi. Bước thiết lập môi trường (tải Python, thư viện AI, FFmpeg) được
; giao cho chính app ở chế độ `--setup-runtime` chứ không viết bằng NSIS: nó tải hơn 1 GB
; và chạy mười tới ba mươi phút, mà NSIS không có cách nào vừa tải vừa vẽ tiến độ — nhét
; vào đây là một hộp thoại treo cứng suốt thời gian đó.
;
; MÃ THOÁT do electron/main.js quy định:
;   0 = môi trường đầy đủ | 2 = cài xong nhưng thiếu vài thành phần | khác = hỏng hoặc bị huỷ.
; KHÔNG mã nào làm HỎNG lượt cài đặt: app tự kiểm lại môi trường ở mỗi lần mở và mở lại cửa
; sổ thiết lập khi cần, nên người dùng luôn còn đường sửa. Chặn cài đặt ở đây chỉ để lại một
; máy không có app lẫn không có môi trường.

; ÉP CÀI THEO NGƯỜI DÙNG — KHÔNG BAO GIỜ CÀI "cho mọi người".
;
; Backend TỰ TẠO thư mục làm việc ngay trong $INSTDIR lúc khởi động: temp_uploads,
; asr_cache, peaks_cache, proxy_cache, concat_cache, reports (xem ensureDirs ở
; backend/server.js). Cài vào Program Files thì mkdir đầu tiên đã chết vì EPERM, backend
; thoát mã 1, và app chỉ kịp hiện "Không thể khởi động backend" rồi đứng — người dùng
; không có cách nào biết nguyên nhân nằm ở chỗ CHỌN thư mục cài mười phút trước đó.
;
; VÌ SAO KHÔNG PHẢI `perMachine: false` LÀ ĐỦ: cờ đó chỉ đặt chế độ MẶC ĐỊNH. Bộ cài dạng
; có trợ lý vẫn hiện trang "Ai được dùng ứng dụng này?" với "Anyone who uses this computer"
; là nút đầu tiên; bấm vào đó là NSIS nâng quyền và chuyển $INSTDIR sang $PROGRAMFILES64.
; Đặt $isForceCurrentInstall thì nhánh ép ở multiUserUi.nsh chạy `Abort` — trang chọn bị bỏ
; qua hẳn, nên KHÔNG CÒN đường nào dẫn tới Program Files nữa, kể cả khi người dùng bấm
; chuột phải "Run as administrator".
;
; Người dùng VẪN đổi được thư mục cài (allowToChangeInstallationDirectory). Điều đó vẫn an
; toàn: không còn nâng quyền nữa nên nếu ai đó tự gõ một chỗ không ghi được, lượt cài chết
; ngay ở bước chép tệp — thấy liền, thay vì để lại một app cài xong mà chạy không nổi.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; CỨU DỮ LIỆU NGƯỜI DÙNG TRƯỚC KHI BẢN CŨ BỊ XOÁ SẠCH
;
; Bản 1.1.8 và cũ hơn để cài đặt, thư viện tài nguyên, báo cáo và cache bóc băng NGAY TRONG
; thư mục cài đặt. Từ bản này chúng chuyển sang %LOCALAPPDATA%\CrabbyCut để sống qua được
; các lần cập nhật (xem USER_DATA_ROOT ở backend/server.js).
;
; VÌ SAO PHẢI LÀ NSIS CHỨ KHÔNG PHẢI CODE TRONG APP: trình gỡ cài bản cũ dời toàn bộ
; $INSTDIR sang thư mục tạm rồi `RMDir /r $INSTDIR`, không chừa ngoại lệ nào. Tới lúc bản
; mới chạy lần đầu thì dữ liệu đã không còn để mà di trú.
;
; VÌ SAO MÓC VÀO `customRemoveFiles`: nó chạy TRONG trình gỡ cài, ngay tại chỗ sắp xoá, nên
; $INSTDIR chắc chắn đang trỏ đúng thư mục cài cũ. Hai điểm móc khác đều không dùng được:
;   · `preInit` chạy ở đầu .onInit, TRƯỚC initMultiUser — $INSTDIR lúc đó còn là giá trị
;     mặc định lúc biên dịch, không phải nơi người dùng đã cài thật.
;   · `customCheckAppRunning` được chèn vào CẢ trình gỡ cài, mà ở đó `${GetProcessInfo}`
;     của macro gốc cần biến thể `un.` — build chết ngay lúc biên dịch NSIS (đã thử).
;
; Macro này THAY THẾ toàn bộ khối xoá tệp, nên phải dựng lại khối đó y như bản gốc ở
; app-builder-lib/templates/nsis/uninstaller.nsh. Thiếu là gỡ cài xong vẫn còn nguyên tệp.
!macro moveUserDataDir DIRNAME
  ; Chỉ chuyển khi nguồn CÓ và đích CHƯA CÓ. Đích đã có nghĩa là người dùng từng chạy bản
  ; mới rồi — đè lên là xoá dữ liệu mới bằng dữ liệu cũ.
  ${If} ${FileExists} "$INSTDIR\resources\app\${DIRNAME}\*.*"
  ${AndIfNot} ${FileExists} "$LOCALAPPDATA\CrabbyCut\${DIRNAME}\*.*"
    DetailPrint "Chuyển ${DIRNAME} sang %LOCALAPPDATA%\CrabbyCut..."
    CreateDirectory "$LOCALAPPDATA\CrabbyCut"
    ; Rename = di chuyển, gần như tức thì vì cùng ổ đĩa ($INSTDIR nằm trong
    ; %LOCALAPPDATA%\Programs). Hỏng thì chép — chậm hơn nhưng vẫn cứu được dữ liệu.
    ClearErrors
    Rename "$INSTDIR\resources\app\${DIRNAME}" "$LOCALAPPDATA\CrabbyCut\${DIRNAME}"
    ${If} ${Errors}
      CreateDirectory "$LOCALAPPDATA\CrabbyCut\${DIRNAME}"
      CopyFiles /SILENT "$INSTDIR\resources\app\${DIRNAME}\*.*" "$LOCALAPPDATA\CrabbyCut\${DIRNAME}"
    ${EndIf}
  ${EndIf}
!macroend

!macro customRemoveFiles
  ; CHỈ DI TRÚ KHI ĐANG CẬP NHẬT. Lượt gỡ cài THẬT thì người dùng đang muốn bỏ ứng dụng —
  ; lôi thư viện của họ sang một thư mục khác chỉ để lại rác mồ côi. Việc dọn thư mục đó
  ; đã có `customUnInstall` bên dưới hỏi riêng.
  ${if} ${isUpdated}
    ; Chỉ những thứ KHÔNG dựng lại được, hoặc dựng lại rất đắt.
    ; Cố ý BỎ QUA temp_uploads / peaks_cache / proxy_cache / concat_cache: chúng tự sinh
    ; lại, và concat_cache có thể vài GB — chuyển đi chỉ làm lượt cập nhật lâu thêm vô ích.
    !insertmacro moveUserDataDir "settings"    ; cài đặt người dùng
    !insertmacro moveUserDataDir "library"     ; tài nguyên họ tự thêm vào
    !insertmacro moveUserDataDir "reports"     ; báo cáo dự án
    !insertmacro moveUserDataDir "asr_cache"   ; bóc băng lại tốn hàng chục phút
  ${endIf}

  ; ─── Từ đây trở xuống là bản dựng lại NGUYÊN VĂN khối xoá gốc của electron-builder ───
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      # Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endIf}

  # Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR
!macroend

!macro customInstall
  ; VÁ LỆNH MỞ FILE .crab — electron-builder ghi THIẾU DẤU NHÁY quanh đường dẫn exe.
  ;
  ; Nó sinh ra `$appExe $\"%1$\"`, tức giá trị registry là
  ;   C:\Users\thanh tam\...\CrabbyCut.exe "%1"
  ; Đường dẫn cài theo người dùng gần như luôn có dấu cách (tên tài khoản Windows), nên
  ; Windows cắt ở dấu cách ĐẦU TIÊN và thử chạy `C:\Users\thanh`. Gặp máy nào tình cờ có
  ; một file trùng đúng cái tên cụt đó — ví dụ log do một bộ cài khác để lại — thì Windows
  ; chạy nhầm vào nó và báo "This app can't run on your PC", một thông báo không hề nhắc
  ; tới CrabbyCut lẫn dấu nháy. Cùng họ với bẫy `spawn python ENOENT` ở mục 7 của
  ; docs/DONG_GOI_VA_MOI_TRUONG.md: phép dò dừng ở thứ trùng tên đầu tiên rồi thôi.
  ;
  ; Ghi đè ở đây được vì registerFileAssociations chạy TRƯỚC customInstall (xem thứ tự ở
  ; installSection.nsh). Đặt TRƯỚC nhánh ${Silent} bên dưới để lượt cài im lặng cũng được vá.
  ; "CrabbyCut Project" là `fileAssociations[].name` trong package.json — đổi bên đó thì
  ; phải đổi cả ở đây.
  WriteRegStr SHELL_CONTEXT "Software\Classes\CrabbyCut Project\shell\open\command" "" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"`

  ; CÀI IM LẶNG (`/S`, triển khai hàng loạt) KHÔNG ĐƯỢC MỞ CỬA SỔ NÀO.
  ; Cửa sổ thiết lập cần người bấm khi có lỗi; bật nó trong một lượt cài không người trông
  ; là ExecWait treo vĩnh viễn và cả lượt triển khai đứng im. Bỏ qua ở đây thì app tự chạy
  ; thiết lập ở lần mở đầu tiên — lúc đó chắc chắn có người ngồi trước máy.
  ${If} ${Silent}
    DetailPrint "Cài im lặng: bỏ qua bước thiết lập môi trường, CrabbyCut sẽ tự chạy ở lần mở đầu tiên."
    Goto skipRuntimeSetup
  ${EndIf}

  DetailPrint "Đang kiểm tra cấu hình máy và thiết lập môi trường cho CrabbyCut..."
  DetailPrint "Bước này tải Python, thư viện AI và FFmpeg — có thể mất 10-30 phút tuỳ tốc độ mạng."

  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --setup-runtime' $0

  ${If} $0 == 0
    DetailPrint "Thiết lập môi trường hoàn tất."
  ${ElseIf} $0 == 2
    DetailPrint "Đã cài đặt nhưng còn thiếu một vài thành phần. Mở CrabbyCut để cài nốt."
  ${Else}
    DetailPrint "Chưa thiết lập được môi trường (mã $0). CrabbyCut sẽ hỏi lại ở lần mở đầu tiên."
  ${EndIf}

  skipRuntimeSetup:
!macroend

; Môi trường nằm ở %LOCALAPPDATA%\CrabbyCut — NGOÀI $INSTDIR, nên trình gỡ cài đặt không tự
; đụng tới. Cố ý hỏi thay vì xoá thẳng: gỡ để cài lại bản mới là việc rất thường, và giữ lại
; thư mục này thì lần cài sau không phải tải lại hơn 1 GB.
!macro customUnInstall
  ${IfNot} ${Silent}
    IfFileExists "$LOCALAPPDATA\CrabbyCut\runtime\*.*" 0 skipRuntimeCleanup
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Xoá luôn môi trường AI đã tải về (Python, thư viện, FFmpeg — khoảng 2 GB)?$\n$\n\
Chọn No nếu bạn định cài lại CrabbyCut: giữ lại thì lần sau không phải tải lại." \
        /SD IDNO IDNO skipRuntimeCleanup
      DetailPrint "Đang xoá môi trường AI..."
      RMDir /r "$LOCALAPPDATA\CrabbyCut\runtime"
    skipRuntimeCleanup:
  ${EndIf}
!macroend
