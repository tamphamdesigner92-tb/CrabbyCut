/* =============================================================================
 * DENOISE WORKLET — bộ TRỪ PHỔ chạy trên AudioWorklet (preview CrabbyCut)
 *
 * VÌ SAO PHẢI CÓ FILE RIÊNG: preview phát bằng thẻ <video>/<audio> thật, không có
 * đường nào nhét filter FFmpeg vào. Muốn nghe được đúng cái mà bản xuất sẽ nghe thì
 * phải tự làm bộ khử nhiễu trong Web Audio. AudioWorklet là chỗ DUY NHẤT chạy được
 * DSP theo khối mà không giật (ScriptProcessorNode chạy trên luồng UI).
 *
 * THUẬT TOÁN (cùng họ với `afftdn` của FFmpeg — xem static/js/audio-denoise.js):
 *   1. STFT: cửa sổ sqrt-Hann 512 mẫu, bước nhảy 128 (chồng 75%).
 *   2. Ước lượng nhiễu bằng THỐNG KÊ CỰC TIỂU trên cửa sổ ~0.5-1 s (xem MIN_WINDOW):
 *      nền ồn lộ ra ở ĐÁY công suất theo thời gian, tức các khoảng nghỉ giữa các từ.
 *   3. Độ lợi kiểu WIENER với SNR tiên nghiệm "hướng theo quyết định" (Ephraim-Malah):
 *      g = ξ/(1+ξ), kẹp sàn tại floorGain (= 10^(-nr/20), CHÍNH LÀ tham số `nr` của
 *      afftdn -> hai đường cùng một mức giảm tối đa).
 *   4. Mượt nhẹ g theo TẦN SỐ (3 bin). Chống "nhiễu nhạc" (musical noise — những đốm
 *      lách tách) chủ yếu là việc của bước 3, không phải của bước làm mượt này.
 *   5. ISTFT + overlap-add, chia lại hệ số chuẩn hoá cửa sổ.
 *
 * ĐO ĐƯỢC (tests/scripts/audio_denoise_pipeline.js, tín hiệu dạng lời nói + ồn trắng):
 * nền ồn ở khoảng nghỉ giảm gần đúng `nr` dB, còn đoạn có tiếng chỉ suy hao ~1.5 dB.
 *
 * ĐỘ TRỄ: đúng một cửa sổ = 512 mẫu ≈ 10.7 ms @48kHz. Đủ nhỏ để không thấy lệch
 * tiếng-hình (ngưỡng cảm nhận ~45 ms), nên KHÔNG bù trễ ở nơi khác. Đổi FRAME to
 * hơn thì phải xem lại điểm này.
 *
 * Tham số nhận qua AudioParam (k-rate, đọc 1 lần mỗi khối 128 mẫu):
 *   floorGain, overSub, noiseFloor  — xem AudioDenoise.previewParams().
 * ========================================================================== */

const FRAME = 512;                 // cửa sổ FFT (phải là luỹ thừa của 2)
const HOP = FRAME / 4;             // bước nhảy: chồng 75%
const BINS = FRAME / 2 + 1;        // số bin phổ hữu ích (nửa dưới + Nyquist)
const FIFO_SIZE = FRAME * 4;       // vòng đệm mẫu ra (thừa sức cho mọi cỡ khối)

/* --- FFT phức radix-2, bảng tra dựng sẵn (kích thước cố định FRAME) --- */
const REV = new Uint16Array(FRAME);
(function buildBitReverse() {
    let bits = 0;
    while ((1 << bits) < FRAME) bits++;
    for (let i = 0; i < FRAME; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        REV[i] = r;
    }
})();

const COS = new Float32Array(FRAME / 2);
const SIN = new Float32Array(FRAME / 2);
for (let i = 0; i < FRAME / 2; i++) {
    COS[i] = Math.cos((-2 * Math.PI * i) / FRAME);
    SIN[i] = Math.sin((-2 * Math.PI * i) / FRAME);
}

// FFT tại chỗ. inverse = true thì đảo dấu twiddle và chia FRAME.
function fft(re, im, inverse) {
    for (let i = 0; i < FRAME; i++) {
        const j = REV[i];
        if (j > i) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    const sign = inverse ? -1 : 1;
    for (let size = 2; size <= FRAME; size <<= 1) {
        const half = size >> 1;
        const step = FRAME / size;
        for (let i = 0; i < FRAME; i += size) {
            for (let j = 0, k = 0; j < half; j++, k += step) {
                const wr = COS[k];
                const wi = SIN[k] * sign;
                const a = i + j;
                const b = a + half;
                const xr = re[b] * wr - im[b] * wi;
                const xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
    if (inverse) {
        for (let i = 0; i < FRAME; i++) { re[i] /= FRAME; im[i] /= FRAME; }
    }
}

/* --- Cửa sổ sqrt-Hann + hệ số chuẩn hoá overlap-add ---
 * Phân tích và tổng hợp cùng nhân sqrt-Hann -> tổng w² qua các bước nhảy là hằng số
 * (tuần hoàn theo HOP); chia lại ở khâu ghép là biên độ về đúng 1:1. Tính bằng vòng
 * lặp thay vì viết hằng số tay: đổi FRAME/HOP không phải sửa lại con số nào. */
const WIN = new Float32Array(FRAME);
for (let n = 0; n < FRAME; n++) {
    WIN[n] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * n) / FRAME)));
}
const OLA_NORM = new Float32Array(HOP);
for (let n = 0; n < HOP; n++) {
    let sum = 0;
    for (let m = n; m < FRAME; m += HOP) sum += WIN[m] * WIN[m];
    OLA_NORM[n] = sum > 1e-8 ? sum : 1;
}

/* --- ƯỚC LƯỢNG NHIỄU: THỐNG KÊ CỰC TIỂU (minimum statistics) ---
 * Cách ngây thơ "trung bình có bám" KHÔNG dùng được: công suất của một bin lúc có
 * tiếng cũng kéo trung bình lên, nên sau vài giây chính giọng nói bị coi là nhiễu và
 * bị cắt sạch (đã đo: giọng mất đúng bằng mức sàn). Nền ồn thật thì lộ ra ở ĐÁY của
 * công suất theo thời gian, nên phải lấy CỰC TIỂU trên một cửa sổ đủ dài để chứa được
 * một khoảng nghỉ giữa các từ.
 *
 * Hai bộ đệm luân phiên: `minCur` gom cực tiểu của cửa sổ đang chạy, `minPrev` giữ
 * cửa sổ trước. Cực tiểu dùng để ước lượng = min của hai cái -> luôn phủ từ MIN_WINDOW
 * tới 2×MIN_WINDOW khung, không bao giờ "quên sạch" ngay sau khi đổi cửa sổ. */
const MIN_WINDOW = 180;              // ~0.48 s @48kHz (180 × 128 mẫu)
// Cực tiểu của một biến ngẫu nhiên luôn THẤP hơn trung bình của nó; nhân bù lại,
// nếu không thì luôn ước lượng thiếu nhiễu và khử được rất ít.
const MIN_BIAS = 1.9;
// Làm mượt công suất trước khi lấy cực tiểu (giảm dao động khung-sang-khung).
const POWER_SMOOTH = 0.8;
/* Hệ số "hướng theo quyết định" (decision-directed, Ephraim–Malah): SNR tiên nghiệm
 * của khung này chủ yếu suy từ KẾT QUẢ khung trước. Đây chính là thứ dập "nhiễu nhạc"
 * — những đốm lách tách mà trừ phổ thẳng tay luôn để lại. */
const DD_ALPHA = 0.98;

/* Trạng thái DSP của MỘT kênh. Mỗi kênh có ước lượng nhiễu riêng — kênh trái/phải
 * của một bản thu thường có nền ồn khác nhau, dùng chung một ước lượng là kênh sạch
 * hơn bị cắt oan. */
class DenoiseChannel {
    constructor() {
        this.window = new Float32Array(FRAME);   // cửa sổ trượt của tín hiệu vào
        this.hop = new Float32Array(HOP);        // mẫu vào đang gom cho bước nhảy tới
        this.hopFill = 0;
        this.ola = new Float32Array(FRAME);      // bộ cộng chồng của tín hiệu ra
        this.re = new Float32Array(FRAME);
        this.im = new Float32Array(FRAME);
        this.power = new Float32Array(BINS);            // công suất đã làm mượt
        this.minCur = new Float32Array(BINS).fill(Infinity);
        this.minPrev = new Float32Array(BINS).fill(Infinity);
        this.minAge = 0;
        this.cleanPrev = new Float32Array(BINS);        // công suất sạch ước lượng khung trước
        this.gain = new Float32Array(BINS).fill(1);
        this.rawGain = new Float32Array(BINS).fill(1);
        this.fifo = new Float32Array(FIFO_SIZE); // mẫu ra chờ được lấy
        this.fifoRead = 0;
        this.fifoCount = HOP;                    // mồi im lặng = độ trễ khởi động
        this.fifoWrite = HOP;
    }

    pushOut(value) {
        this.fifo[this.fifoWrite] = value;
        this.fifoWrite = (this.fifoWrite + 1) % FIFO_SIZE;
        if (this.fifoCount < FIFO_SIZE) {
            this.fifoCount++;
        } else {
            // Không bao giờ xảy ra ở nhịp bình thường; nếu có thì bỏ mẫu CŨ NHẤT để
            // độ trễ không tăng dần thay vì để tràn im lặng.
            this.fifoRead = (this.fifoRead + 1) % FIFO_SIZE;
        }
    }

    pullOut() {
        if (this.fifoCount === 0) return 0;
        const value = this.fifo[this.fifoRead];
        this.fifoRead = (this.fifoRead + 1) % FIFO_SIZE;
        this.fifoCount--;
        return value;
    }

    // Một bước nhảy đã đủ mẫu -> trượt cửa sổ, chạy STFT, đẩy HOP mẫu ra FIFO.
    advance(floorGain, overSub, noiseFloor) {
        const { window, re, im, power, minCur, minPrev, cleanPrev, gain, rawGain, ola } = this;
        window.copyWithin(0, HOP);
        window.set(this.hop, FRAME - HOP);

        for (let n = 0; n < FRAME; n++) {
            re[n] = window[n] * WIN[n];
            im[n] = 0;
        }
        fft(re, im, false);

        // Cửa sổ cực tiểu hết hạn -> đẩy sang bộ đệm "trước" và bắt đầu cửa sổ mới.
        if (++this.minAge >= MIN_WINDOW) {
            this.minAge = 0;
            minPrev.set(minCur);
            minCur.fill(Infinity);
        }

        const noiseFloorPower = noiseFloor * noiseFloor;
        const floorPower = floorGain * floorGain;
        for (let k = 0; k < BINS; k++) {
            const obs = re[k] * re[k] + im[k] * im[k];
            power[k] += (obs - power[k]) * (1 - POWER_SMOOTH);
            if (power[k] < minCur[k]) minCur[k] = power[k];
            const tracked = MIN_BIAS * Math.min(minCur[k], minPrev[k]);
            // `noiseFloor` (quy từ tham số nf của afftdn) là CẬN DƯỚI: nguồn vốn đã sạch
            // thì đừng bịa ra nhiễu để trừ.
            const lambda = Math.max(tracked, noiseFloorPower) * overSub;

            // SNR hậu nghiệm (đo được ngay) và SNR tiên nghiệm (suy chủ yếu từ khung trước).
            const gamma = obs / (lambda + 1e-20);
            const xi = DD_ALPHA * (cleanPrev[k] / (lambda + 1e-20))
                + (1 - DD_ALPHA) * (gamma > 1 ? gamma - 1 : 0);
            const g = xi / (1 + xi);
            rawGain[k] = g < floorGain ? floorGain : (g > 1 ? 1 : g);
        }
        // Mượt nhẹ theo TẦN SỐ (3 bin): độ lợi lởm chởm giữa các bin kề nhau là thứ
        // sinh ra tiếng lách tách kim loại.
        for (let k = 0; k < BINS; k++) {
            const a = rawGain[k > 0 ? k - 1 : 0];
            const c = rawGain[k < BINS - 1 ? k + 1 : BINS - 1];
            gain[k] = (a + 2 * rawGain[k] + c) * 0.25;
        }

        // Áp độ lợi, giữ đối xứng Hermit để IFFT trả về tín hiệu thực.
        for (let k = 0; k < BINS; k++) {
            const g = gain[k];
            const obs = re[k] * re[k] + im[k] * im[k];
            cleanPrev[k] = g * g * obs;      // đầu vào của bước "hướng theo quyết định" khung sau
            if (cleanPrev[k] < floorPower * obs) cleanPrev[k] = floorPower * obs;
            re[k] *= g;
            im[k] *= g;
            const mirror = FRAME - k;
            if (k > 0 && mirror > k) {
                re[mirror] = re[k];
                im[mirror] = -im[k];
            }
        }
        fft(re, im, true);

        for (let n = 0; n < FRAME; n++) ola[n] += re[n] * WIN[n];
        for (let n = 0; n < HOP; n++) this.pushOut(ola[n] / OLA_NORM[n]);
        ola.copyWithin(0, HOP);
        ola.fill(0, FRAME - HOP);
    }

    write(sample, floorGain, overSub, noiseFloor) {
        this.hop[this.hopFill++] = sample;
        if (this.hopFill >= HOP) {
            this.hopFill = 0;
            this.advance(floorGain, overSub, noiseFloor);
        }
    }
}

class DenoiseProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'floorGain', defaultValue: 0.126, minValue: 0.0005, maxValue: 1, automationRate: 'k-rate' },
            { name: 'overSub', defaultValue: 1.8, minValue: 1, maxValue: 6, automationRate: 'k-rate' },
            { name: 'noiseFloor', defaultValue: 0.0316, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
    }

    constructor() {
        super();
        this.channels = [];
    }

    ensureChannels(count) {
        while (this.channels.length < count) this.channels.push(new DenoiseChannel());
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || !output.length) return true;
        this.ensureChannels(output.length);

        const floorGain = parameters.floorGain[0];
        const overSub = parameters.overSub[0];
        const noiseFloor = parameters.noiseFloor[0];

        for (let ch = 0; ch < output.length; ch++) {
            const src = (input && input[ch]) ? input[ch] : null;
            const state = this.channels[ch];
            const dst = output[ch];
            for (let i = 0; i < dst.length; i++) {
                state.write(src ? src[i] : 0, floorGain, overSub, noiseFloor);
                dst[i] = state.pullOut();
            }
        }
        // Giữ node sống kể cả khi nguồn im lặng: <video> có thể pause rồi phát lại,
        // trả false là node chết luôn và lần phát sau không còn tiếng.
        return true;
    }
}

registerProcessor('crabbycut-denoise', DenoiseProcessor);
