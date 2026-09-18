# CrabbyCut — Kế hoạch làm preview mượt

> **Trạng thái:** kế hoạch, CHƯA thi công. Lập 2026-09-06 trên nhánh `CrabbyCut_v1.1.1-Win`
> (HEAD `b2722b5`).
>
> **Điểm đau cụ thể người dùng báo:** preview giật, **nặng nhất ở giai đoạn Match Script**
> (`currentMode === 'MAPPED'`, step2).
>
> **Cách đọc:** Phần A đối chiếu nghiên cứu Premiere/CapCut với mã CrabbyCut hiện có — đọc
> phần này TRƯỚC, nó ngăn việc xây lại thứ đã có. Phần B là bản kiểm kê những gì thật sự
> chạy mỗi khung hình. Phần C là các giai đoạn thi công.

---

## Vì sao đợt tối ưu trước không hiệu quả

Đợt 1-5 (04-05/09, nay nằm ở nhánh `perf/dot-1-5-260905`) đã bị người dùng loại bỏ vì
không cải thiện được cảm nhận và còn gây lỗi hiển thị panel Timeline. Ba nguyên nhân, ghi
lại để không lặp:

1. **Đo trên fixture tổng hợp, không phải phiên làm việc thật.** Số liệu "77,2 → 33,3 ms
   mỗi lượt cuộn" là thật, nhưng nó đo một thứ có thể không phải nút thắt trên máy và dự án
   của người dùng.
2. **Gộp quá nhiều việc vào một commit.** P1+P2+P4+P5+P6+P8 đi chung một đợt; khi Timeline
   hiện lỗi thì không có cách nào bỏ đúng thủ phạm mà giữ phần còn lại — chỉ còn cách vứt
   cả đợt.
3. **Không có số đo "giật" khách quan.** Frame-time dao động tới ~29% nên chênh lệch nhỏ
   không phân biệt được với nhiễu. Con số đúng cho "preview giật" là
   `video.getVideoPlaybackQuality().droppedVideoFrames`, và nó chưa bao giờ được đo.

**Ba nguyên tắc bắt buộc của kế hoạch này:**

- Mỗi giai đoạn = **một commit, một việc, tự đứng được, revert riêng được**.
- **Không giai đoạn nào được thi công trước Giai đoạn 0.** Không có số liệu trên dự án
  thật thì mọi tuyên bố cải thiện chỉ là phỏng đoán.
- Mỗi giai đoạn phải ghi rõ **cách người dùng tự kiểm bằng mắt** và **lệnh revert**.

---

## Phần A — Nghiên cứu của bạn đối chiếu với mã CrabbyCut hiện có

Cột "bằng chứng" là chỗ đã đọc trực tiếp trong mã tại thời điểm lập kế hoạch.

| # | Kỹ thuật (theo nghiên cứu) | Hiện trạng CrabbyCut | Bằng chứng |
|---|---|---|---|
| 1 | Lõi đồ hoạ native C++ (DirectX/Vulkan/Metal) | ❌ **Không có và sẽ không làm** — xem *Những gì KHÔNG làm*. Nhưng phần thay thế thực tế đã có: preview hợp thành bằng **WebGL qua PixiJS**, chạy trên D3D11 của Chromium | `index.html:5678` `new PIXI.Application` |
| 2a | Giải mã phần cứng | ⚠️ **Có sẵn nhưng chưa chắc đang bật** — Chromium tự giải mã H.264 bằng GPU khi bật tăng tốc. Chưa có switch Electron nào, chưa ai kiểm chứng nó thật sự chạy | `electron/main.js:15` chỉ có nhánh *tắt* GPU |
| 2b | Zero-copy, không copy ngược về RAM | ✅ **Đường preview đã sạch** — không có `getImageData`/`readPixels` nào chạy mỗi khung. Các chỗ đọc ngược chỉ dùng cho hút màu, thumbnail, xuất PNG | `index.html:5638` (hút màu), `editing-runtime.js:12518` (thumbnail LUT) |
| 2c | Frame nằm nguyên trong VRAM | ⚠️ **Có một lỗ rò** — ticker gọi `baseTexture.update()` **mỗi tick, kể cả khi đang DỪNG**, trong khi PIXI `VideoResource` đã tự cập nhật qua `requestVideoFrameCallback`. Tức là nạp lại đúng khung hình cũ lên GPU 60 lần/giây | `index.html:5708` |
| 3 | Hiệu ứng bằng GPU shader | ✅ **Đã làm** — Điều chỉnh màu, mặt nạ, đường cong tone đều là GLSL, khớp từng bước với filter FFmpeg tương ứng | `static/js/color-adjust.js:9,111,494` |
| 4 | Nội suy chuyển động thời gian thực | ✅ **Đã làm** — keyframe (`position/scale/rotation/opacity`) nội suy theo easing tại thời điểm `t`, không dựng frame trước | `static/js/text-animations.js:439,490` |
| 5 | Tách dữ liệu / metadata pipeline | ✅ **Đã làm** — hiệu ứng là JSON trên item; engine đọc tham số rồi nạp vào shader | `editingItems[].style/.keyframes/.animation` |
| 6.1 | Độ phân giải động khi phát | ❌ **CHƯA CÓ** — đây là khoảng trống lớn nhất và đúng nghĩa "chuyên nghiệp" |  |
| 6.2 | Hệ thống proxy ngầm | ✅ **Đã làm, và làm tốt** — proxy 720p, **all-intra `-g 1 -bf 0`** (đúng bài để tua mượt), encoder phần cứng khi có, tự lùi về CPU khi lỗi | `native/sidecar/core_process.cpp:2120-2160` |
| 6.3 | Bộ nhớ đệm khung hình / pre-render | ❌ **Chưa có** |  |

**Kết luận của Phần A:** CrabbyCut đã gần với mô hình "chuyên nghiệp" hơn nhiều so với ấn
tượng ban đầu. Điểm 3, 4, 5 coi như xong; điểm 6.2 làm đúng bài. Khoảng trống thật nằm ở
**6.1, 6.3, và phần "đừng chống lại GPU" của 1-2**.

---

## Phần B — Kiểm kê: cái gì THẬT SỰ chạy mỗi khung hình ở Match Script

Đây là phần dễ suy đoán sai nhất, nên mỗi dòng đều đã truy đến tận nơi. Một đính chính
đáng chú ý nằm ở cuối bảng.

Khi đang phát, `perf-runtime.js` chặn `timeupdate` ở pha **capture** rồi
`stopImmediatePropagation()` (`perf-runtime.js:1670`), nên **handler `timeupdate` của
`index.html:9995` KHÔNG chạy trong lúc phát**. Vòng phát thật là
`queuePlaybackLoop()` gắn qua `requestVideoFrameCallback`.

| Nhịp | Chạy gì | Giá | Trạng thái |
|---|---|---|---|
| mỗi khung video | `runJumpCutLogic()` | rẻ | ổn |
| ≤30 Hz | `updateTimeDisplayOnly()` | rẻ | ổn |
| ≤30 Hz | `scrollTimelineToCurrentTime()` → ghi `scrollLeft` | <0,1 ms | ổn |
| ≤30 Hz (hệ quả) | sự kiện `scroll` → `markDirty('timelineVisual')` → `baseUpdateTimelineLayout()` = `drawRuler` + `drawWaveform` + `drawTimelineSegments` + `timelineRenderer.resize()` | **nặng** | ⚠️ **nghi can 1** |
| ≤30 Hz | `markDirty('transcriptActive')` → `syncVirtualTranscript()` | ? | cần đo |
| 60 Hz | ticker PIXI **preview**: `baseTexture.update()` + `updateBackgroundPulse()` | nạp lại texture thừa | ⚠️ **nghi can 2** |
| 60 Hz | ticker PIXI **timeline**: render kể cả khi không có gì đổi | ? | ⚠️ **nghi can 3** |

**Đính chính một giả định của chính tôi:** ban đầu tôi tưởng
`updateSequencePreviewTransform()` (kéo theo `resizeAndRender()` và cấp phát lại backbuffer
WebGL) chạy mỗi khung ở mọi giai đoạn. **Sai** — nó nằm trong handler `timeupdate` đã bị
chặn. Ở step4 nó chạy mỗi khung qua `startOverlayPreviewLoop()`
(`editing-runtime.js:10633`), nhưng **ở Match Script thì không**. Ghi lại để không ai đi
tối ưu nhầm chỗ.

**Nghi can 1** chính là thứ Đợt 1 đã sửa (guard `isProgrammaticScroll`) và đã đo được
47,9 ms mỗi lượt × 30 Hz ≈ **1.437 ms việc mỗi giây phát**. Bản sửa đó hiện **không còn
trong nhánh này**. Nó vẫn là ứng viên số một — nhưng lần này phải đo trước, và đi riêng
một commit để nếu Timeline lại lỗi thì revert đúng một dòng.

---

## Kết quả đo Giai đoạn 0 — lượt 1 (2026-09-06, dự án thật, Match Script)

Hai lượt đo trên máy người dùng (GTX 1060). **Kết quả bác bỏ giả thuyết chính của kế
hoạch này** — ghi lại đầy đủ vì nó định lại toàn bộ thứ tự thi công.

| | Lượt 1 | Lượt 2 |
|---|---|---|
| Khung hình RỚT | 131 / 1244 = **10,5%** | 919 / 3060 = **30,0%** |
| Nhịp UI (rAF) | 19 fps, TB 50,9 ms, tệ nhất 116,7 ms | 22 fps, TB 45,4 ms, tệ nhất 100,0 ms |
| Long task | **0** | **0** |
| Timeline vẽ lại | 40 lượt, 14,4 ms | 50 lượt, 17,2 ms |
| Transcript sync | 11 lượt, 13,6 ms | 13 lượt, 7,5 ms |
| Preview transform | 1 lượt, 0,5 ms | 1 lượt, 0,7 ms |
| Cuộn bám playhead | 16 lượt, 3,9 ms | 20 lượt, 5,7 ms |
| Ticker PIXI | 3 ticker, 57 lượt, 11,6 ms | 3 ticker, 66 lượt, 14,3 ms |
| **TỔNG JS đo được** | **44,0 ms / 1000 ms = 4,4%** | **45,4 ms / 1000 ms = 4,5%** |

### Ba kết luận, theo thứ tự quan trọng

**1. Nút thắt KHÔNG nằm ở JavaScript.** Toàn bộ JS đo được chỉ chiếm ~4,5% một giây
(≈2,1 ms trong ngân sách 45 ms mỗi khung), trong khi 30% khung hình bị rớt. **95,5% thời
gian không giải thích được bằng JS.** `Long task = 0` củng cố: luồng chính KHÔNG bị chặn —
khung hình đơn giản là không được sinh/hợp thành ra.

**2. Điều này giải thích vì sao Đợt 1-5 vô hiệu.** "Nghi can 1" (Timeline vẽ lại — đúng
thứ P1 của Đợt 1 sửa) tốn **14,4-17,2 ms mỗi giây, tức 1,4-1,7% ngân sách**. Sửa hết cũng
không ai cảm nhận được. Con số cũ "47,9 ms × 30 Hz ≈ 1.437 ms mỗi giây" **lệch khoảng 100
lần** so với thực tế ở Match Script — nó đo một fixture tổng hợp 120 block ở Editing với
DOM dựng lại toàn bộ, không mô tả phiên làm việc thật. Đây chính là cái giá của việc đo
sai chỗ.

**3. Ngưỡng cảnh báo của HUD đã sai và đã sửa.** Bản đầu chỉ có một ngưỡng 20 fps gắn nhãn
"cửa sổ bị che": lượt 19 fps bị **báo động nhầm**, lượt 22 fps thì **im lặng**, trong khi
cả hai là cùng một hiện tượng và đều KHÔNG do che cửa sổ (bị che thật thì rAF về ~0 — đã
đo trực tiếp). Nay tách hai ngưỡng: `OCCLUDED_FPS = 3` (compositing dừng hẳn) và
`SLOW_FPS = 50` (GPU/compositor đuối — số liệu THẬT, đáng đi tìm).

### Câu hỏi kế tiếp, và bốn số đo đã thêm để trả lời

Thời gian nằm ở tầng dưới JS: giải mã video, hoặc hợp thành GPU. HUD nay hiện thêm:

- **GPU** — chuỗi renderer thật, có cảnh báo `⚠ PHẦN MỀM!` nếu rơi vào SwiftShader/llvmpipe
  (Chromium render bằng CPU thì đúng ra dấu hiệu này).
- **Nguồn video** — độ phân giải + đang phát **LQ proxy** hay **HQ gốc**. Proxy 720p đã có
  sẵn; nếu đang phát HQ 4K thì riêng điều đó đã đủ giải thích.
- **Canvas preview** — số điểm ảnh GPU phải hợp thành mỗi khung. `resolution` đang chốt
  cứng `min(devicePixelRatio, 2)`, nên trên màn HiDPI có thể đang hợp thành gấp 4 lần cần thiết.
- **Khung trình bày** — nhịp khung video thật sự lên màn hình, tách khỏi nhịp UI.

**Cần lượt đo 2** với bốn số này trước khi viết bất kỳ dòng tối ưu nào.

---

## Kết quả đo Giai đoạn 0 — lượt 2 (2026-09-06, lúc DỪNG)

Lượt này chụp ở trạng thái `○ dừng`, nên **không** nói gì về lúc phát. Nhưng giá trị của nó
là **loại trừ**, và nó loại trừ được gần hết.

| Số đo | Giá trị | Loại trừ điều gì |
|---|---|---|
| GPU | ANGLE (NVIDIA GTX 1060, **D3D11**) | ❌ không phải render bằng phần mềm |
| Nguồn video | **406×720 · LQ proxy** | ❌ không phải đang phát HQ 4K; proxy ĐANG hoạt động |
| Canvas preview | **266×475 = 0,13 MP** | ❌ không phải nghẽn số điểm ảnh hợp thành |
| Nhịp UI lúc dừng | **60 fps**, TB 16,7 ms, tệ nhất **16,8 ms** | ❌ không có vấn đề nền tảng — lúc rảnh app mượt tuyệt đối |
| Ticker PIXI lúc dừng | 3 ticker · **180 lượt/giây** · 24,9 ms | ⚠️ **lãng phí đã xác nhận** (nghi can 3) |

### Hai kết luận

**1. `Độ phân giải động khi phát` (GĐ4) coi như VÔ NGHĨA ở cấu hình này.** Canvas preview
chỉ 0,13 MP — hạ tiếp cũng không còn gì để tiết kiệm. Gạch khỏi danh sách ưu tiên. Đây là
lần thứ hai số liệu bác bỏ một giai đoạn tôi từng xếp hạng cao; may là chưa viết dòng nào.

**2. Ticker PIXI chạy 180 lượt/giây khi KHÔNG có gì thay đổi.** 3 ticker × 60 fps, tốn
24,9 ms mỗi giây để vẽ lại đúng cái đã có. Bằng 2,5% ngân sách — không phải thủ phạm chính,
nhưng là lãng phí thuần và đã được chứng minh bằng số.

⚠️ **Lưu ý về cách đọc con số 24,9 ms:** nó là thời gian **CPU bên trong** lời gọi ticker.
Nó KHÔNG bao gồm cái giá GPU mà lời gọi đó gây ra sau đó (nạp texture, đồng bộ pipeline).
Một `texImage2D` có thể trả về ngay trên CPU nhưng làm nghẽn compositor ở khung sau. Vì vậy
**không được kết luận "ticker chỉ đáng 2,5%"** — phải đo bằng phép thử A/B (F10).

### Câu hỏi còn lại, và cách trả lời dứt điểm

Lúc dừng: rAF 60 fps hoàn hảo. Lúc phát: rAF sập còn 19-22 fps, rớt 30% khung, JS chỉ 4,5%,
long task = 0. Nền tảng khoẻ, nhưng cứ phát là sập. Chỉ còn ba khả năng:

| | Giả thuyết | Đo bằng |
|---|---|---|
| (a) | Nghẽn giải mã / nạp dữ liệu. Proxy là **all-intra `-g 1`** — tua thì mượt nhưng **bitrate cao hơn hẳn** và nặng giải mã hơn GOP thường | `Tua / chờ / kẹt`, `Đệm sẵn`, `readyState` |
| (b) | Tua liên tục do jump-cut. `runJumpCutLogic` gán `video.currentTime` mỗi khi playhead rời một chunk đã chọn; mỗi lần gán là một lần xả bộ giải mã | `Tua ... lượt/giây` |
| (c) | Nghẽn đường nạp texture GPU (không zero-copy) — đúng điểm #2 trong nghiên cứu | **phép thử A/B: F10** |

(b) chỉ chạy khi `isPreviewing` bật (nút Preview Cuts) — xem `perf-runtime.js:1521`. Nếu
bạn chỉ bấm Play thường thì nhánh này không chạy, và bộ đếm sẽ cho thấy điều đó.

**Phép thử A/B (F10) là thứ dứt điểm nhất trong cả bộ đo:** tắt hẳn ticker PIXI ngay giữa
lúc đang phát. rAF vọt lên 60 và hết rớt khung → thủ phạm là (c). Không đổi gì → loại (c),
còn (a) và (b).

---

## Kết quả đo Giai đoạn 0 — lượt 3: NGƯỜI DÙNG TỰ CHẠY A/B, và nó dứt điểm

Người dùng đính chính: **mọi lượt đo giật trước đó đều dùng nút "Xem trước (Preview
Cuts)"**. Đo lại bằng Play thường thì **không giật**.

| | Preview Cuts BẬT | Play thường |
|---|---|---|
| Khung hình RỚT | **10,5%** và **30,0%** | **1 / 6261 = 0,0%** |
| Nhịp UI | 19-22 fps | **60 fps**, tệ nhất 16,8 ms |
| Nguồn video | 406×720 · LQ proxy (**0,29 MP**) | 1728×3072 · HQ gốc (**5,31 MP**) |

**Bản nặng hơn 18 lần về số điểm ảnh lại là bản chạy mượt tuyệt đối.** Không còn cách nào
đổ lỗi cho giải mã, GPU, hợp thành, ticker PIXI hay JavaScript. Cả ba giả thuyết (a), (c)
và toàn bộ Phần B đều bị loại. Thủ phạm là **chế độ Preview Cuts** — giả thuyết (b).

⚠️ **Một nhiễu phải ghi nhận cho trung thực:** hai lượt đo còn khác nhau ở nguồn (LQ proxy
so với HQ gốc), tức hai biến đổi cùng lúc. Cơ chế bên dưới giải thích được kết quả, nhưng
để chặt chẽ thì cần một lượt Preview Cuts có bộ đếm `Tua` để chốt.

### Cơ chế, đã truy đến tận nơi

Preview Cuts bật `isPreviewing`, mở cổng cho `runJumpCutLogic()`
(`perf-runtime.js:1521`). Ở MAPPED, hàm này chạy **mỗi khung video** và gán
`video.currentTime` mỗi khi playhead chạm mép một chunk đã chọn
(`perf-runtime.js:1590`, `:1606`). **Mỗi lần gán là một lần XẢ BỘ GIẢI MÃ** — trình duyệt
vứt hàng đợi khung đã giải mã và dựng lại từ đầu. Đó chính là `droppedVideoFrames`.

Match Script là nơi tệ nhất vì chunk ở đây ngắn nhất (mức câu/cụm), nên mép chunk — tức
lệnh tua — dày đặc nhất.

**Hai điều đã kiểm và loại khỏi diện nghi ngờ:**

- `getMappedSelectedChunks()` (`perf-runtime.js:130`) **có cache**, không dựng mảng mới mỗi
  khung → `jumpCursor` không bị reset liên tục. Giả thuyết phụ này đã chết.
- Proxy đo trên máy: 406×720, **5,87 Mbps**, all-intra. Cao hơn GOP thường nhưng thừa sức
  cho bất kỳ máy nào — và dù sao bản HQ 5,31 MP còn chạy mượt. **Không phải lỗi proxy.**

**Điều CHƯA có, và là chỗ đáng sửa:** trong toàn bộ `runJumpCutLogic()` **không có một
guard `video.seeking` nào**. Không có gì ngăn việc ra lệnh tua mới khi lệnh tua trước còn
đang dở.

---

## Giai đoạn 1 — GỘP ĐOẠN LIỀN NHAU TRONG PREVIEW CUTS · ĐÃ THI CÔNG (2026-09-06)

**Quyết định sản phẩm (người dùng chốt):** ưu tiên **chính xác tuyệt đối**. Không bao giờ
phát nội dung đã bỏ chọn, kể cả khi khe rất ngắn. Vì vậy bản sửa **không** đổi hành vi —
chỉ bỏ những lệnh tua vô nghĩa.

Hai thay đổi, cùng một commit:

1. **`getMappedPlaybackSpans()`** (`perf-runtime.js`) — gộp các chunk đã chọn **nằm liền
   nhau** thành một đoạn phát liên tục. Hai chunk liên tiếp có
   `chunk[i].end === chunk[i+1].start`, nên lệnh tua ở mép đó nhảy tới đúng chỗ video đang
   đứng: vô nghĩa, nhưng vẫn xả sạch hàng đợi giải mã. Mọi khe đã bỏ chọn vẫn bị nhảy qua
   y như cũ. Ngưỡng nối `SPAN_JOIN_EPS = 0,04s` (~1 khung) vì mép do ASR sinh hiếm khi
   trùng tuyệt đối.
2. **`seekPlayback()`** — mọi lệnh tua của vòng phát đi qua một cổng duy nhất có guard
   `video.seeking`. Bỏ qua một khung là an toàn: khung sau `runJumpCutLogic` chạy lại và
   điều kiện vẫn còn, nên lệnh tua chỉ bị hoãn chứ không mất.

### Đo trên app thật, đường phát MAPPED thật

| Thế trận | Khe THẬT | Lệnh tua bản CŨ | Lệnh tua ĐO ĐƯỢC |
|---|---|---|---|
| 3 chunk · 1 khe 2s | 1 | 1 | **1** (tua tới đúng 4,0s) |
| 16 chunk 0,5s · 2 khe | 2 | 13 | **2** (tua tới 3,0 và 6,0) |
| **16 chunk 0,5s · chọn HẾT** | 0 | 15 | **0** |

Ca thứ ba là ca thường gặp nhất ở Match Script — chọn gần hết — và nó đi từ **15 lệnh tua
xuống 0**.

**Kiểm lời hứa chính xác:** phát qua khe 2,0-4,0s, chỗ lọt sâu nhất vào vùng đã bỏ chọn là
**0,064s = 2 khung** — đúng độ trễ tua vốn có (điều kiện kích hoạt là `end - 0,05` cộng
một hai khung để lệnh tua đáp). Không phải do bản sửa. Rớt 1/2112 khung.

⚠️ **Một cái bẫy khi tự kiểm lại:** `markMappedSelectionDirty()` nằm trong IIFE của
`perf-runtime.js`, **không gọi được từ Console**. Lần đo đầu của tôi vì thế đọc phải danh
sách đoạn CŨ còn trong cache và cho số liệu vô nghĩa (báo lọt 1,986s). Đường hợp lệ để nạp
lựa chọn mới là **`renderWordLevelTranscript(chunks, 'MAPPED')`**.

**Cách bạn tự kiểm bằng mắt:** bật Preview Cuts ở Match Script, xem có nhảy đúng các đoạn
đã chọn không, và bấm F9 xem dòng `Tua / chờ / kẹt`.

**Revert:** `git revert <sha của commit này>` — chỉ đụng `perf-runtime.js`.

---

## Phần C — Các giai đoạn thi công

> **⚠ Thứ tự dưới đây đã được SẮP XẾP LẠI theo số liệu lượt 1.** Giai đoạn 1 và 3 của bản
> kế hoạch đầu (bỏ nạp texture thừa, guard cuộn) nay **xuống cuối**: cộng cả hai chỉ đáng
> ~25 ms/giây trên tổng 1000 ms. Chúng không sai, chỉ là không đáng làm trước.

**Xếp hạng mới, chờ lượt đo 2 chốt:**

| Ưu tiên | Việc | Vì sao |
|---|---|---|
| **1** | **Giảm số lệnh tua trong Preview Cuts** (`runJumpCutLogic`) | Đã khoanh vùng bằng A/B của người dùng: Play thường 0,0% rớt, Preview Cuts 30% rớt |
| ~~2~~ | ~~GĐ4 — Độ phân giải động khi phát~~ | **GẠCH** — lượt đo 2 cho thấy canvas preview chỉ 0,13 MP, không còn gì để tiết kiệm |
| ~~3~~ | ~~GĐ2 — `powerPreference` + switch Electron~~ | **GẠCH** — Play thường đã 60 fps ở HQ 5,31 MP; GPU không phải nút thắt |
| 4 | GĐ6 — Bộ nhớ đệm khung hình | Nặng, chỉ làm nếu số liệu đòi |
| ~~5~~ | ~~GĐ1 — bỏ `baseTexture.update()` thừa~~ | Đo được 11,6-14,3 ms/giây = 1,2-1,4% |
| ~~6~~ | ~~GĐ3 — guard cuộn theo chương trình~~ | Đo được 14,4-17,2 ms/giây = 1,4-1,7% |


### Giai đoạn 0 — Dụng cụ đo (BẮT BUỘC, làm trước tiên)

Không phải bộ bench tổng hợp như lần trước. Lần này là **một lớp phủ HUD nhỏ, bật bằng
phím tắt, chạy trên chính dự án thật của bạn**.

Hiển thị trực tiếp trong lúc phát:
- **`droppedVideoFrames / totalVideoFrames`** — con số khách quan cho "giật"; đây mới là
  thứ tương ứng với cảm nhận, và nó không thể bị đánh lừa bởi một vòng lặp chạy nhanh
  nhưng rớt khung.
- FPS thực của vòng phát.
- Thời gian từng pha: `jumpCut`, `timelineRelayout`, `transcriptSync`, `pixiPreviewTick`,
  `pixiTimelineTick` — dùng bộ tích luỹ (`sum`/`count`/`max`), không đẩy mảng.
- Bộ đếm số lượt `baseUpdateTimelineLayout()` mỗi giây.

Ràng buộc: một file mới, ~150 dòng, **no-op hoàn toàn khi chưa bật**, không đụng vào bất
kỳ đường chạy nào sẵn có.

**Bạn cần làm:** mở dự án thật, vào Match Script, bấm phát ~15 giây, chụp màn hình HUD.
Chạy hai lần: một lần bình thường, một lần cửa sổ **ghim lên trên cùng** (Chromium dừng
compositing khi cửa sổ bị che — số liệu sẽ vô nghĩa nếu bị che).

**Điều kiện chuyển tiếp:** có bảng số liệu nền. Thứ tự các giai đoạn dưới đây **sẽ được
sắp xếp lại theo số liệu này** — chúng đang xếp theo *phỏng đoán*, không phải theo đo đạc.

---

### Giai đoạn 1 — Bỏ nạp lại texture thừa (nghi can 2)

`index.html:5708` gọi `baseTexture.update()` mỗi tick. PIXI `VideoResource` đã đặt
`_autoUpdate = true` và dùng `requestVideoFrameCallback` (Electron 31 có). Bỏ dòng này ở
đường thường, **giữ nguyên nhánh `spatialActive`** (đường canvas trung gian thật sự cần
dựng lại mỗi khung) và **giữ fallback** khi trình duyệt không có
`requestVideoFrameCallback`.

- **Rủi ro:** thấp. Sai thì preview đứng hình khi tạm dừng — thấy ngay lập tức.
- **Bạn kiểm:** phát → hình chạy mượt; tạm dừng → hình vẫn đúng khung; kéo playhead lúc
  dừng → hình đổi theo. Bật Retouch/Điều chỉnh (đường `spatialActive`) → vẫn cập nhật.
- **Lợi ích dự kiến:** ở 4K là ~24 MB × 60/s `texImage2D` biến mất. Càng rõ trên máy yếu.

### Giai đoạn 2 — Đưa preview lên đúng GPU

App PIXI **timeline** có `powerPreference: 'high-performance'`
(`pixi-timeline-renderer.js:73`), app PIXI **preview** thì **không** (`index.html:5678`).
Trên laptop hai card, preview có thể đang chạy bằng iGPU.

Cùng giai đoạn: đặt `backgroundThrottling: false` trong `webPreferences`, và cân nhắc
switch bật zero-copy/d3d11 video decode ở `electron/main.js`.

- **Rủi ro:** thấp, nhưng **phải kiểm cả nhánh `CRABBYCUT_DISABLE_GPU=1`** — thay đổi nào
  làm máy không-GPU xấu đi thì không nhận.
- **Bạn kiểm:** HUD của Giai đoạn 0 trước/sau; thêm `chrome://gpu` để xác nhận
  "Video Decode: Hardware accelerated".

### Giai đoạn 3 — Guard cuộn theo chương trình (nghi can 1)

**Đúng một dòng:** ở listener `scroll` của `perf-runtime.js`, bỏ qua
`markDirty('timelineVisual')` khi `isProgrammaticScroll` đang bật. Giữ nguyên
`applyRendererViewport()` + `renderRulerDomLabels()` (rẻ, và *cần* chạy).

An toàn về mặt ngữ nghĩa vì cuộn tự động chỉ dịch khung nhìn, không đổi hình học block;
mọi thay đổi hình học thật đều tự gọi `updateTimelineLayout()`.

- **Rủi ro:** đây chính là chỗ Đợt 1 làm và Timeline sinh lỗi hiển thị. **Lần này đi một
  mình một commit.** Có lỗi → `git revert` đúng commit đó, không mất gì khác.
- **Bạn kiểm:** phát ở Match Script → thước và block vẫn vẽ đúng, playhead vẫn bám giữa;
  cuộn tay → vẫn vẽ lại bình thường; zoom → vẫn đúng.

### Giai đoạn 4 — Độ phân giải động khi phát (điểm 6.1 — khoảng trống lớn nhất)

Khi bấm Play, hạ `renderer.resolution` của app preview xuống 1/2 (hoặc 1/4 tuỳ mức tải);
khi Pause, trả về đầy đủ và render lại một lượt. Đây **khác** với proxy: proxy đổi *tệp
nguồn*, còn cái này đổi *số điểm ảnh phải hợp thành mỗi khung*.

Hiện `resolution: Math.min(window.devicePixelRatio || 1, 2)` là cố định
(`index.html:5684`) — tức trên màn hình HiDPI, preview đang hợp thành ở **gấp 4 lần** số
điểm ảnh cần thiết trong lúc phát.

- **Rủi ro:** trung bình. Phải đảm bảo lúc Pause trả lại nét ngay; và mọi phép đo toạ độ
  (khung transform, mặt nạ) không được đọc `resolution`.
- **Bạn kiểm:** phát → hình hơi mềm nhưng mượt; dừng → nét lại ngay lập tức.
- **Ghi chú:** nếu Giai đoạn 0 cho thấy nút thắt nằm ở **giải mã** chứ không ở **hợp
  thành**, thì giai đoạn này gần như vô ích — đó là lý do phải đo trước.

### Giai đoạn 5 — Dừng ticker PIXI khi rảnh (nghi can 3)

App timeline: `autoStart:false`, gọi `render()` ở cuối mỗi lối vẽ. Ở step4,
`renderEditingTimeline()` xoá stage về rỗng rồi ticker vẫn render một stage rỗng 60 lần/giây.

**Hợp đồng bắt buộc:** khi ticker dừng, `resizeAndRender()` phải kết thúc bằng
`app.render()` — đặt ở cuối chính hàm đó, **không** rải ở 20+ chỗ gọi. Bỏ sót một chỗ là
preview đứng hình khi kéo slider lúc tạm dừng.

- **Rủi ro:** cao nhất trong danh sách. Ship **mặc định tắt** sau một cờ, bật sau khi có
  số liệu.

### Giai đoạn 6 — Bộ nhớ đệm khung hình (điểm 6.3)

Chỉ làm nếu số liệu chứng minh cần. Nặng nhất, dễ sai nhất (vô hiệu hoá cache sai chỗ là
preview hiện khung cũ — lớp lỗi rất khó phát hiện).

---

## Những gì KHÔNG làm

- **Không viết engine C++/Vulkan/DirectX riêng.** Đó không phải tối ưu, đó là viết lại
  ứng dụng từ đầu — bỏ toàn bộ tầng UI, timeline, inspector, hoạt ảnh hiện có. Phần thay
  thế thực tế (WebGL + shader + proxy + giải mã phần cứng của Chromium) đã có sẵn và chưa
  được khai thác hết; hãy khai thác hết trước đã.
- **Không đụng vào đường export** trong kế hoạch này. Export và preview là hai bài toán
  khác nhau; trộn vào là không biết cái gì làm nên khác biệt.
- **Không gộp nhiều giai đoạn vào một commit**, kể cả khi chúng đều nhỏ.
- **Không nhận một thay đổi nào làm số liệu ở nhánh `CRABBYCUT_DISABLE_GPU=1` xấu đi**,
  bất kể nó đẹp thế nào trên máy có GPU.

---

## Bảng theo dõi

| GĐ | Nội dung | Trạng thái | Số liệu trước/sau |
|---|---|---|---|
| 0 | Dụng cụ đo HUD (`static/js/perf-hud.js`, F9 · A/B F10) | **XONG — đã khoanh trúng thủ phạm: Preview Cuts**. Lượt 1+2+3 — kết luận: JS chỉ chiếm 4,5% ngân sách, nút thắt nằm dưới tầng JS. Đã thêm 4 số đo GPU/nguồn/canvas, **chờ lượt đo 2** | JS 44,0 / 45,4 ms mỗi giây; rớt 10,5% / 30,0% khung |
| 1 | **Gộp đoạn liền nhau trong Preview Cuts** | **XONG** — chờ bạn test | 15 → **0** lệnh tua khi chọn hết; 13 → **2** khi có 2 khe |
| 2 | ~~Căn bề rộng proxy theo bội số 16~~ | **KHÔNG CẢI THIỆN — ứng viên revert** | 400px vẫn rớt 38,8% |
| 3 | ~~Bỏ all-intra ở proxy~~ | **THẤT BẠI — đã trả lại** | khung giải mã 63 → **77-87** fps |
| 4 | **Mặc định xem trước bằng HQ** | **XONG** — quyết định theo kết quả, nguyên nhân gốc CHƯA rõ | HQ rớt 0-6% so với LQ 10-38% |
| 5 | Dừng ticker PIXI khi rảnh | chưa làm | — |
| 6 | Bộ nhớ đệm khung hình | chưa làm | — |

---

## Giai đoạn 2 — CĂN BỀ RỘNG PROXY THEO BỘI SỐ 16 · ĐÃ THI CÔNG (2026-09-06)

### Một giả thuyết của tôi đã BỊ BÁC BỎ — ghi lại để không ai đi lại

Tôi từng nêu: "proxy dài hơn nguồn 11ms nên mốc chunk lệch, sinh lệnh tua thừa". **Sai.**
Tách ba con số ra thì rõ:

| | container | luồng VIDEO | luồng AUDIO |
|---|---|---|---|
| nguồn | 8,300000s | **8,300000s · 249 khung** | 8,289524s |
| proxy | 8,310998s | **8,300000s · 249 khung** | 8,310998s |

Luồng video **giống hệt** — cùng số khung, cùng thời lượng, cùng `start_time`. 11ms nằm ở
**audio** (đệm của bộ mã hoá AAC). `video.currentTime` trỏ đúng cùng nội dung ở cả hai
file, nên mốc chunk KHÔNG lệch.

→ **`Tua = 0` ở HQ nhưng `2-3` ở LQ vẫn CHƯA CÓ LỜI GIẢI.** Đừng coi mục này là đã đóng.

### Việc đã làm

`scale=-2` chỉ đảm bảo bề rộng CHẴN. Nguồn dọc 1728×3072 ra proxy **406px** — chẵn nhưng
không chia hết cho 4/8/16. Bộ giải mã phần cứng làm việc theo macroblock 16×16.

Đổi nhánh CPU sang `-16` (`native/sidecar/core_process.cpp`). Đã build lại sidecar và chạy
thật: nguồn 1080×1920 → proxy **400×720**, 249 khung, 8,300000s — căn hàng đúng, luồng
video vẫn khớp nguồn từng khung.

**Nhánh VideoToolbox (macOS) CỐ Ý giữ `-2`**: không có máy Mac để kiểm `scale_vt` có nhận
cú pháp `-16` không; sai ở đó thì proxy hỏng hẳn trên Mac.

### ⚠️ Mức tin cậy: THẤP — đây là bản sửa theo thông lệ, KHÔNG theo số đo

Vấn đề chỉ lộ ra ở tầng hợp thành của cửa sổ THẬT. Môi trường đo tự động (Browser pane ẩn)
không dựng tầng đó: 4 biến thể proxy (406 all-intra / 400 căn-16 / 406 GOP thường / bản
gốc) đều giải mã như nhau, 0 khung rớt. Thí nghiệm **vô kết luận**, không phải phủ định.

**Nếu đo lại trên máy thật mà không cải thiện thì REVERT** — đừng để nó nằm lại như một
"bản sửa" không ai kiểm chứng. Cần dựng lại proxy một lần để bản sửa có hiệu lực.

### Bảng số liệu nền để đối chiếu (10 lượt, máy người dùng)

```
HQ gốc   1728×3072 (4 lượt): rớt 0,0 / 0,2 / 2,3 / 5,9 %   rAF 60 (tệ nhất 16,8ms)  Tua 0
LQ proxy  406×720  (6 lượt): rớt 10,0 … 30,0 %             rAF 19-30 (tệ nhất 100ms) Tua 2-3
```

Bốn điều đã chắc chắn: JS không phải nút thắt (lượt mượt nhất có JS **cao nhất** —
10,6% so với 4,3%); long task luôn 0; không phải nghẽn đệm (LQ đệm 38s vẫn giật, HQ đệm
2,8s vẫn mượt); không phải độ phân giải (bản 5,31 MP mượt hơn bản 0,29 MP).

---

## Lượt đo sau Giai đoạn 2 (2026-09-06) — CĂN 16 KHÔNG CẢI THIỆN

```
Nguồn video      400×720 · LQ proxy      ← bản sửa GĐ2 ĐÃ có hiệu lực
Khung hình RỚT   1415 / 3647  (38,8%)    ← TỆ HƠN trước (22-26%)
Nhịp UI          40 fps
Tua / chờ / kẹt  1 / 1 / 0               ← gần như không tua
Đệm sẵn          0,9s                    ← RẤT THẤP
TỔNG JS          57,3ms (5,7%)
```

Người dùng phát bằng Preview Cuts, **không tua tay**, và **càng về cuối càng giật hơn**.

**→ Giai đoạn 2 (căn bội số 16) KHÔNG cải thiện. Theo đúng quy tắc đã ghi trong mục đó,
nó là ứng viên REVERT.** Giữ lại thì phải ghi rõ là "đúng thông lệ nhưng vô tác dụng ở đây",
không được để trôi thành "đã sửa".

Cũng loại luôn giả thuyết tua: chỉ **1 lệnh tua/giây** mà vẫn rớt 38,8%.

### Lỗ hổng của chính dụng cụ đo, đã vá

Người dùng đã báo suy giảm THEO THỜI GIAN hai lần — "càng về cuối càng giật" và "bật tắt
app nhiều lần thì giật hơn" — nhưng mọi số của HUD đều là **ảnh chụp một giây**, nên nó mù
hoàn toàn với đúng thứ quan trọng nhất. Đã thêm ba số:

| Dòng mới | Bắt cái gì |
|---|---|
| `Ns gần nhất … ↑ ĐANG TỆ DẦN / = ổn định / ↓ đang đỡ hơn` | so cửa sổ 10s gần nhất với tích luỹ — biến "tệ dần" thành con số |
| `Bộ nhớ JS   N MB (+M MB từ lúc bật)` | rò rỉ bộ nhớ; cảnh báo khi tăng > 200 MB |
| `Đệm sẵn … (thấp nhất Xs)` | cạn đệm thoáng qua mà ảnh chụp bỏ lỡ |

### Hai giả thuyết còn lại, và cách phân biệt

`Đệm sẵn 0,9s` trên một tệp cục bộ ĐÃ HOÀN CHỈNH (proxy chỉ được công bố sau khi ffmpeg
xong hẳn — `backend/server.js:1770`) là bất thường. Hai khả năng:

- **(A) Rò rỉ bộ nhớ** — bộ nhớ phình dần, Chromium bắt đầu thu hồi bộ đệm media để bù,
  đệm cạn dần, rớt khung tăng dần. Khớp với CẢ HAI tín hiệu suy giảm.
  → dòng `Bộ nhớ JS` sẽ cho thấy: tăng đều = trúng.
- **(B) Đọc tệp không theo kịp** — bitrate proxy ~5,9 Mbps all-intra, đọc qua HTTP từ
  Express. → dòng `Đệm sẵn (thấp nhất)` sẽ luôn thấp ngay từ đầu, không phải giảm dần.

Phân biệt được bằng một lượt đo: **bộ nhớ tăng dần** = (A); **đệm thấp ngay từ đầu và
không đổi** = (B).

---

## Giai đoạn 3 — BỎ ALL-INTRA Ở PROXY · ĐÃ THI CÔNG (2026-09-06)

### Hai số đo của HUD từng SAI, đã sửa

1. **"nhịp khung TỆP"** — tôi thêm nó để đọc nhịp khung của tệp. Sai:
   `requestVideoFrameCallback` bắn tối đa MỘT lần mỗi khung compositor, nên khi compositor
   tụt xuống 17 fps thì số này bị kẹp xuống 18,3. Nay tách thành hai dòng nói đúng bản chất:
   `Khung giải mã` (phía bộ giải mã, không bị kẹp) và `Khung LÊN MÀN HÌNH`.
2. Nhãn nút **LQ/HQ** nói dối (xem commit riêng) — làm nhiễu toàn bộ chuỗi đo trước đó.

### Con số dẫn tới bản sửa

```
Khung giải mã      63 fps
Khung LÊN MÀN HÌNH 18.3 fps    ← hơn 2/3 công giải mã bị VỨT ĐI
Nhịp UI            17 fps  ·  TỔNG JS 3.6%  ·  Long task 0
```

Bộ giải mã làm gấp 3,4 lần lượng việc đến được màn hình, trong khi JS rảnh 96%.

### Đánh đổi đã ĐẢO CHIỀU

`-g 1` (all-intra) từng đúng: mỗi lệnh tua gần như tức thì, mà Preview Cuts tua ở MỖI mép
chunk. Hai điều đã đổi:

1. **Giai đoạn 1 bỏ ~90% lệnh tua** — còn 2 lệnh/giây, và bằng 0 khi lựa chọn liền mạch.
2. **Đo được nghẽn nằm ở tầng giải mã**, không phải JS.

Đo trên nguồn mẫu 1080×1920 30fps:

| | Bitrate (libx264 CRF) | Khung I |
|---|---|---|
| `-g 1` | 3,40 Mbps | **249** (mọi khung) |
| `-g 30` | 1,81 Mbps | **9** |

Đã build lại sidecar và chạy thật: proxy ra 400×720, 30fps, 249 khung, **9 khung I**.
`-bf 0` giữ nguyên (không B-frame → thứ tự giải mã trùng thứ tự hiển thị, tua chính xác).

**Cái mất:** mỗi lệnh tua phải giải mã lại từ khung I gần nhất — tối đa ~1 giây khung hình.
Với ~2 lệnh tua/giây thì rẻ hơn hẳn gánh giải mã liên tục.

⚠️ **Chưa kiểm chứng trên cửa sổ thật** (môi trường đo tự động không dựng được tầng hợp
thành). Không cải thiện thì TRẢ LẠI `-g 1`.

### Ứng viên tiếp theo, CHƯA làm

`PreviewBitrate()` = **6000k** (`core_process.cpp:734`) cho một proxy 400×720. Con số đó
được chọn cho all-intra; với GOP thường nó dư khoảng 3-4 lần. Nhánh NVENC dùng `-b:v` cố
định nên bitrate KHÔNG tự giảm theo GOP — proxy vừa dựng vẫn 4,86 Mbps. Hạ xuống ~1500k sẽ
giảm tiếp tải giải mã và I/O, đổi lại preview hơi mờ hơn. **Chưa làm vì một commit chỉ nên
làm một việc.**

---

## Giai đoạn 3 THẤT BẠI — đã trả lại. Và quyết định dừng: mặc định dùng HQ

### `-g 30` làm TỆ HƠN, đo được

```
khung GIẢI MÃ mỗi giây, proxy 30fps:
  -g 1  (all-intra)  ->  63 fps
  -g 30 (Giai đoạn 3)->  77-87 fps      ← TỆ HƠN
rớt khung: ~20%  ->  20,4% và 27,1%, đều "↑ ĐANG TỆ DẦN"
```

**Vì sao lập luận của tôi sai:** tôi tính phần tiết kiệm ở phát tuần tự mà quên tính phần
trả thêm ở mỗi lệnh tua. Preview Cuts tua 2-4 lần MỖI GIÂY, và chi phí một lệnh tua là số
khung phải giải mã lại từ khung I gần nhất:

| | mỗi lệnh tua | với 2-4 lệnh/giây |
|---|---|---|
| `-g 1` | 1 khung | +2..4 khung/giây |
| `-g 30` | tối đa 30 khung | **+60..120 khung/giây** |

**All-intra là lựa chọn ĐÚNG cho khối lượng tua này.** Đã trả `-g 1` về và khoá bằng test
(`proxy_alignment.js` giờ khẳng định proxy PHẢI all-intra, kèm lý do).

Bài học chung: **bitrate thấp hơn và ít khung I hơn KHÔNG đồng nghĩa giải mã nhẹ hơn** khi
đường chạy có nhiều lệnh tua. Muốn đổi phải đo `Khung giải mã` trên HUD, đừng suy từ dung
lượng tệp.

### Quyết định: mặc định xem trước bằng BẢN GỐC (HQ)

Người dùng chốt sau khi thử: HQ không giật, LQ giật ở mọi cấu hình đã thử.

```
bản gốc 1728×3072 (5,31 MP) -> rớt 0-6%,   nhịp UI 60 fps chằn chặn
proxy    400×720  (0,29 MP) -> rớt 10-38%, nhịp UI 17-40 fps
```

`previewQualityMode` mặc định đổi thành `'original'`. Proxy VẪN được dựng, nút LQ/HQ vẫn
đổi được — chỉ đổi mặc định.

⚠️ **Giới hạn đã biết, phải nhớ:** quyết định dựa trên MỘT máy (GTX 1060) với nguồn ~5 MP.
Máy yếu hơn hoặc nguồn 4K/8K có thể ngược lại. Đây là quyết định **theo kết quả đo, không
phải theo hiểu nguyên nhân**.

### CÂU HỎI GỐC VẪN CHƯA CÓ LỜI GIẢI

**Vì sao một video 0,29 MP lại làm compositor sập xuống 17-40 fps, trong khi cùng máy, cùng
cửa sổ, video 5,31 MP chạy 60 fps chằn chặn?**

Đã thử và LOẠI hết: tải JS (3-10%, và lượt MƯỢT nhất lại là lượt JS CAO nhất), long task
(luôn 0), rò rỉ bộ nhớ (+2..10 MB), cạn đệm (2,5-4,3s), số lệnh tua (1-4/giây, và có lượt
0 lệnh vẫn giật), căn bề rộng 16, all-intra, lệch mốc thời gian proxy/nguồn.

Ứng viên chưa thử: `PreviewBitrate()` = 6000k cho proxy 400×720 (`core_process.cpp:734`) —
dư 3-4 lần; nhánh NVENC dùng `-b:v` cố định nên bitrate không giảm theo GOP.

---

## Giai đoạn 4 — SÓNG ÂM Ở EDITING KHÔNG CÓ BỘ ĐỆM · ĐÃ THI CÔNG (2026-09-08)

### Người dùng tự khoanh vùng, và nó dứt điểm

Dự án thật `Hải Vương - Tập 2_ver 4.crab`, giai đoạn Editing, chỉ bấm Play (KHÔNG Preview
Cuts), không thao tác gì thêm:

| | Khung hình RỚT | 10s gần nhất | Nhịp UI | khoảng cách TB |
|---|---|---|---|---|
| như cũ | 294 / 566 (51,9%) | 264/436 (60,6%) ↑ TỆ DẦN | **25 fps** | 40,0 ms |
| như cũ, để chạy tiếp | 2002 / 2899 (69,1%) | 459/567 (81,0%) ↑ TỆ DẦN | **13 fps** | 76,9 ms |
| **kéo panel timeline xuống cho DẢI SÓNG ra khỏi khung nhìn** | — | — | **hết giật hẳn** | — |
| F10 (tắt mọi ticker PIXI) khi đang giật | 69,1% | 81,0% | 13 fps | **KHÔNG cải thiện** |

Hai điều bị LOẠI ngay tại đây:

- **Không phải đường vẽ preview.** Ticker PIXI tắt hẳn mà vẫn 13 fps. `Preview transform`
  đo được 16,6 ms/25 lượt = **0,66 ms mỗi khung**.
- **Không phải JS.** `TỔNG JS` chỉ 41,4 ms/1000 ms (4,1%) ở lượt 25 fps và 24,8 ms (2,5%)
  ở lượt 13 fps. `Long task` luôn 0.

Ở 13 fps mỗi khung có 76,9 ms, mà HUD chỉ giải thích được ~1,9 ms trong đó. **95% thời gian
mỗi khung nằm ngoài mọi bộ đếm.**

### Nguyên nhân, và vì sao HUD không thấy nó

`drawEditingWaveforms` (`editing-runtime.js`) gọi thẳng `AudioWaveform.paintViewport`, còn
listener `'scroll'` của `#timelineTrackOuter` gọi nó ở MỌI lượt cuộn. Lúc phát, timeline
cuộn bám playhead **mỗi khung** ⇒ **tô lại cả dải sóng mỗi khung**. `drawColumns` dựng một
`ctx.rect()` cho MỖI CỘT, hai lượt (peak + RMS): khung nhìn ~2000 px ở dpr 1,5 là ~6000 hình
chữ nhật mỗi khung.

Chi phí đó **không hiện trong đồng hồ JS**: Canvas 2D của Chromium chỉ GHI LẠI lệnh vẽ ở
luồng JS (0,6 ms trung vị) rồi ra-xter BẤT ĐỒNG BỘ trên luồng raster — và chính luồng đó
chẹn compositor. Đây là lý do HUD báo "JS rảnh, GPU/compositor không theo kịp" suốt mấy
lượt đo trước.

**Điều đáng ghi nhất: bản sửa cho đúng bệnh này ĐÃ CÓ SẴN** — `ensureWaveStrip` trong
`index.html` (Giai đoạn "bộ đệm dải sóng", cùng số đo 28,9 fps → 60,0 fps). Nhưng nó nằm
trong IIFE của `index.html` và **chỉ phục vụ timeline các bước 1-3**. Giai đoạn Editing có
canvas sóng RIÊNG (`#editingWaveformCanvas`, đa lane) và **chưa bao giờ được nối vào bộ đệm
đó**. Hai đường vẽ, một đường có đệm, một đường không.

### Việc đã làm

1. **Bộ đệm chuyển vào `audio-waveform.js`** thành `paintViewportBuffered(view, targets)` —
   MỘT bản cài đặt, dùng chung. Version dữ liệu do chính module tăng trong `emitChange`
   (trước đây bên gọi phải tự đếm `waveDataVersion`, và Editing thì không đếm gì cả).
   Chữ ký hình học nay có thêm **`gain` và MÀU** từng target: Editing có Volume riêng mỗi
   block và màu riêng mỗi loại lane — thiếu chúng thì kéo Volume mà sóng không đổi.
2. **`drawEditingWaveforms` dùng `paintViewportBuffered`** (`bufferKey: 'editing'`,
   `contentWidth: outer.scrollWidth`).
3. **`drawWaveform` (bước 1-3) chuyển sang cùng hàm đó**, xoá bản cục bộ
   (`WAVE_STRIP_MAX_DEVICE_PX` / `waveStrip` / `waveStripSignature` / `ensureWaveStrip`).
   Không còn hai bản sao để lệch nhau.
4. **Test** (`npm run test:audio-waveform`): chốt HÀNH VI đệm, không phải hình vẽ — lượt đầu
   dựng đệm và KHÔNG vẽ rect nào vào canvas hiển thị; cuộn trong phạm vi đệm chỉ `drawImage`
   (`rebuilt === false`, `sx` đúng vị trí); peak đổi thì dựng lại; khung nhìn quá trần đệm
   thì lui về `paintViewport` như cũ.

### Cách tự kiểm bằng mắt

Mở `_ver 4.crab`, F9, bấm Play **để dải sóng NẰM TRONG khung nhìn**. Sóng âm phải giống hệt
như trước tới từng pixel (đây là bộ đệm, không phải sóng tượng trưng), `Nhịp UI` phải về
~60 fps và `Khung hình RỚT` gần 0. Rồi kéo Volume một block và kéo playhead qua đó: sóng
phải cao/thấp theo — nếu nó đứng im thì chữ ký đệm bị thiếu tham số.

**Revert:** `git revert <sha>` — chỉ đụng `audio-waveform.js`, `editing-runtime.js`,
`index.html`, và test.

### Hai thứ ĐI KÈM, phải ghi lại

- **Quyết định "mặc định HQ" cần xem lại.** Người dùng báo giờ **LQ mượt hơn HQ**, ngược hẳn
  kết luận 06/09. Không có gì mâu thuẫn: lượt đo 06/09 có `Canvas preview` **0,13 MP**, còn
  lượt này **1,06 MP (773×1377)** — người dùng đã kéo khung xem trước to hơn 8 lần. Khi tổng
  công hợp thành mỗi khung đã sát trần thì giảm nguồn video mới có tác dụng. Quyết định cũ
  vẫn "theo số đo", chỉ là số đo của một cấu hình khác.
- **HUD có điểm mù, đã biết.** `PHASES` bọc các hàm TOÀN CỤC `drawRuler` / `drawWaveform` /
  `drawTimelineSegments` / `updatePlayhead` (`perf-hud.js:48`). Đường vẽ của Editing nằm
  trong IIFE của `editing-runtime.js` và KHÔNG có mặt trên `window`, nên
  `Timeline vẽ lại 125 lượt/giây · 7,8 ms` là của timeline bước 1-3, **không phải** của
  Editing. Dù vậy, thêm nó vào HUD cũng chỉ đo được ~0,6 ms (phần ghi lệnh) — muốn thấy công
  raster thì phải A/B kiểu "tắt riêng nó đi", như người dùng vừa làm.

### Đã thử và BỎ trong lượt này (ghi để không đi lại)

Tôi từng nghi **nguồn media**: `_Cuted.mp4` (nguồn của _ver 4_) có I-frame mỗi **250 khung
= 4,17 s**, còn nguồn DJI của _ver 3_ là **30 khung = 0,5 s**; và cả hai `temp_input.mp4`
đều là bản **chép luồng** (`shouldNormalizeForConcat` chỉ mã hoá lại `.webm` và HDR; 23 file
DJI có chữ ký luồng giống nhau ⇒ bỏ qua chuẩn hoá; sidecar `concat` dùng `-c copy`).
Giả thuyết này **đã chết** khi người dùng cho biết _ver 3_ **cũng** rớt khung theo HUD, chỉ
là mắt thường ít thấy hơn — tức cùng một bệnh, khác mức độ, không phải khác nguồn.

Nhưng một hệ quả của việc đi đường này **vẫn còn giá trị và CHƯA sửa**:
`PREVIEW_FRIENDLY_GOP_ARGS` (commit `6dbfa3f`) nằm trong `normalizeVideoForConcat`, mà dự án
một-nguồn-đã-hợp-lệ **không đi qua hàm đó** ⇒ `temp_input.mp4` thừa hưởng nguyên GOP 4,17 s
của file gốc. Việc này không liên quan tới bệnh sóng âm, nhưng vẫn làm mỗi lệnh tua
(Preview Cuts, mép clip) đắt gấp ~8 lần. Muốn sửa thì đưa "GOP quá dài" thành một điều kiện
của `shouldNormalizeForConcat`, chứ không chỉ vá phía encoder.

---

## Giai đoạn 5 — PROXY LQ CHO ASSET OVERLAY · ĐÃ THI CÔNG (2026-09-08)

### Người dùng khoanh vùng phần còn lại

Sau khi sóng âm có bộ đệm (Giai đoạn 4), lane chính đã mượt. Còn lại đúng một biến:

| | kết quả |
|---|---|
| bật video ở lane overlay | **giật** |
| tắt video ở lane overlay | **hết giật** |

Và một thiếu sót lộ ra cùng lúc: **nút LQ chỉ hạ chất lượng lane CHÍNH.** Asset overlay
phát thẳng file gốc qua `/api/source-file`, nên bấm LQ rồi vẫn còn nguyên một bộ giải mã
1920×1080@60fps chạy song song với lane chính.

### Việc đã làm

1. **Mỗi asset video có một proxy LQ riêng**, dựng bằng CHÍNH sidecar `preview-proxy` mà
   lane chính dùng (cao tối đa 720, bề rộng chia hết cho 16, all-intra `-g 1`). All-intra
   đặc biệt đáng giá ở overlay: `syncMediaElement` TUA phần tử overlay mỗi khi lệch > 0,22s.
2. **Nút LQ/HQ nay ăn cả lane overlay.** `previewAssetUrl(asset)` trả proxy khi đang ở LQ;
   `mediaKey` mang URL hiệu dụng nên bấm nút là phần tử `<video>` được dựng lại — thiếu chỗ
   này thì `src` giữ nguyên từ lúc tạo và cái nút thành vô nghĩa với overlay.
3. **Proxy KHÔNG BAO GIỜ chạm vào bản xuất.** `asset.url`/`asset.path` giữ nguyên bản gốc;
   chỉ ba chỗ ở đường preview đọc `previewAssetUrl`. Đây là chỗ khác hẳn `ensureSdrAsset`
   (bản SDR cố tình thay cả `path`) — chi tiết trong `docs/APP_INTERNALS.md`.
4. **Sinh trước, không ai phải chờ:** job kick lúc asset vào panel "Tệp phương tiện", cạnh
   chỗ prewarm sóng âm. Kéo xuống timeline trước khi xong cũng không chặn gì.
5. **Phân phối tải — ba tầng** (yêu cầu của người dùng: chạy ngầm nhưng không được làm giật):
   một job tại một thời điểm; ưu tiên tiến trình BELOW_NORMAL; và **cổng "đang phát"** —
   frontend ping `/api/background-jobs/gate` khi phát, hàng đợi không mở job mới trong lúc
   đó. Tầng thứ ba là tầng quan trọng nhất: proxy dùng NVENC/NVDEC, tức tranh chấp đúng
   phần cứng mà preview đang cần, và ưu tiên CPU không che được chuyện đó.
6. **Test** `npm run test:asset-proxy`.

### Cách tự kiểm bằng mắt

Mở `_ver 4.crab`, bấm nút **LQ** (góc dưới khung xem trước), rồi phát qua đoạn có block
`5.mp4`. Với F9: `Khung hình RỚT` phải gần 0 và `Nhịp UI` ~60 fps ở CẢ đoạn có overlay.
Đổi về HQ là hình overlay nét lại ngay (phần tử được dựng lại).

Kiểm phần "không ai phải chờ": kéo một video mới vào panel Tệp phương tiện, đợi vài giây,
xem `proxy_cache/` có file mới. Kiểm cổng: bấm Play rồi kéo thêm 5 video vào panel — không
được thấy giật thêm; job sẽ chạy sau khi dừng phát.

Kiểm điều quan trọng nhất — **bản xuất KHÔNG được 720p**: xuất một đoạn có block overlay
trong lúc đang bật LQ, rồi `ffprobe` file ra. Overlay phải ở độ phân giải gốc.

**Revert:** `git revert <sha>` — `backend/server.js`, `index.html`,
`static/js/editing-runtime.js`, test, `.gitignore`, `package.json`.

### Giới hạn đã biết, ghi để không tưởng là lỗi

- **Trần prewarm 24 file mỗi lượt nhập.** `/api/editing-assets/link` nhận cả cây thư mục;
  xếp hàng vài trăm lượt encode là biến "chạy ngầm cho đỡ chờ" thành nhiều giờ máy nóng và
  vài GB proxy cho clip còn chưa ai xem. Vượt trần không mất gì — kéo block xuống timeline
  là job được xếp ngay lúc đó.
- **Nhãn nút vẫn nói về LANE CHÍNH.** Proxy lane chính chưa xong thì nút ghi "HQ (proxy chưa
  sẵn sàng)" dù overlay đã chạy proxy. Đổi nhãn cho nói về cả hai lane là việc riêng, và
  phải cẩn thận: chính dòng nhãn này từng làm nhiễu cả một chuỗi đo (xem
  `updatePreviewQualityButton`).
- **Chưa đo được trên máy thật.** Không chạy được GUI Electron từ môi trường thi công; số
  liệu phải do người dùng chụp bằng F9.
