(function () {
    function cssColorToHex(value, fallback) {
        if (typeof value !== 'string') return fallback;
        const trimmed = value.trim();
        if (trimmed.startsWith('#')) {
            const raw = trimmed.slice(1);
            if (raw.length === 3) {
                const expanded = raw.split('').map((c) => c + c).join('');
                return parseInt(expanded, 16);
            }
            if (raw.length >= 6) {
                return parseInt(raw.slice(0, 6), 16);
            }
        }
        const rgb = trimmed.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (rgb) {
            return (parseInt(rgb[1], 10) << 16) | (parseInt(rgb[2], 10) << 8) | parseInt(rgb[3], 10);
        }
        return fallback;
    }

    class PixiTimelineRenderer {
        constructor() {
            this.app = null;
            this.trackEl = null;
            this.rootEl = null;
            this.width = 0;
            this.height = 0;

            this.theme = {
                primary: 0x5865f2,
                success: 0x23a55a,
                muted: 0x949ba4,
                border: 0x2f3136,
                text: 0xf2f3f5,
            };

            this.rulerLayer = null;
            this.segmentsLayer = null;

            this.rulerTicks = null;
            this.rulerBase = null;
            this.segmentPool = [];
            this.rulerLabelPool = [];

            this.viewportStart = 0;
            this.viewportEnd = Number.POSITIVE_INFINITY;

            this.lastRulerSignature = '';
            this.lastSegmentsSignature = '';
            this.lastSegmentsDataRef = null;
        }

        init(trackEl) {
            if (!window.PIXI) {
                throw new Error('PIXI runtime is missing.');
            }
            this.trackEl = trackEl;
            this.rootEl = trackEl.querySelector('#timelinePixiRoot');
            if (!this.rootEl) {
                throw new Error('Cannot find #timelinePixiRoot container.');
            }

            this.updateTheme();

            this.app = new PIXI.Application({
                width: 1,
                height: 1,
                antialias: true,
                autoDensity: true,
                resolution: Math.min(2, window.devicePixelRatio || 1),
                backgroundAlpha: 0,
                powerPreference: 'high-performance',
            });
            this.app.renderer.roundPixels = true;

            this.app.view.style.width = '100%';
            this.app.view.style.height = '100%';
            this.app.view.style.display = 'block';
            this.app.view.style.pointerEvents = 'none';
            this.rootEl.innerHTML = '';
            this.rootEl.appendChild(this.app.view);

            this.rulerLayer = new PIXI.Container();
            this.segmentsLayer = new PIXI.Container();

            this.rulerBase = new PIXI.Graphics();
            this.rulerTicks = new PIXI.Graphics();

            this.rulerLayer.addChild(this.rulerBase);
            this.rulerLayer.addChild(this.rulerTicks);

            this.app.stage.addChild(this.rulerLayer);
            this.app.stage.addChild(this.segmentsLayer);
        }

        updateTheme() {
            const css = getComputedStyle(document.documentElement);
            this.theme.primary = cssColorToHex(css.getPropertyValue('--primary'), this.theme.primary);
            this.theme.success = cssColorToHex(css.getPropertyValue('--success'), this.theme.success);
            this.theme.muted = cssColorToHex(css.getPropertyValue('--text-muted'), this.theme.muted);
            this.theme.border = cssColorToHex(css.getPropertyValue('--border-color'), this.theme.border);
            this.theme.text = cssColorToHex(css.getPropertyValue('--text-main'), this.theme.text);
        }

        resize(width, height) {
            if (!this.app) return;
            this.width = Math.max(1, Math.floor(width));
            this.height = Math.max(1, Math.floor(height));
            this.app.renderer.resize(this.width, this.height);
            this.lastRulerSignature = '';
            this.lastSegmentsSignature = '';
        }

        setViewport({ start, end }) {
            const nextStart = Math.max(0, Number(start) || 0);
            const nextEnd = Math.max(nextStart, Number(end) || nextStart);
            if (nextStart === this.viewportStart && nextEnd === this.viewportEnd) {
                return;
            }
            this.viewportStart = nextStart;
            this.viewportEnd = nextEnd;
        }

        getRulerSteps(zoomScale) {
            let majorStep = 10;
            let minorStep = 1;
            if (zoomScale > 150) {
                majorStep = 2;
                minorStep = 0.5;
            } else if (zoomScale > 60) {
                majorStep = 5;
                minorStep = 1;
            } else if (zoomScale < 20) {
                majorStep = 60;
                minorStep = 10;
            }
            return { majorStep, minorStep };
        }

        getSegmentGeometry() {
            const areaTop = this.height * 0.5;
            const areaHeight = Math.max(1, this.height * 0.5 - 12);
            return {
                areaTop,
                areaHeight,
                blockTop: areaTop + (areaHeight * 0.15),
                blockHeight: areaHeight * 0.7,
            };
        }

        getRulerLabel(index) {
            if (!this.rulerLabelPool[index]) {
                const label = new PIXI.Text('', {
                    fontFamily: 'monospace',
                    fontSize: 11,
                    fill: this.theme.muted,
                    align: 'left',
                });
                this.rulerLabelPool[index] = label;
                this.rulerLayer.addChild(label);
            }
            return this.rulerLabelPool[index];
        }

        hideUnusedRulerLabels(fromIndex) {
            for (let i = fromIndex; i < this.rulerLabelPool.length; i += 1) {
                this.rulerLabelPool[i].visible = false;
            }
        }

        renderRuler({ timelineDuration, zoomScale, sidePadding, formatTime, showLabels = true }) {
            if (!this.app) return;
            const { majorStep, minorStep } = this.getRulerSteps(zoomScale);
            const baseY = 25;

            const viewportBucket = `${Math.round(this.viewportStart)}:${Math.round(this.viewportEnd)}`;
            const rulerSignature = [
                this.width,
                this.height,
                Math.round(timelineDuration * 100),
                Math.round(zoomScale * 100),
                Math.round(sidePadding),
                majorStep,
                minorStep,
                viewportBucket,
                showLabels ? '1' : '0',
            ].join('|');
            if (rulerSignature === this.lastRulerSignature) {
                return;
            }
            this.lastRulerSignature = rulerSignature;

            this.rulerBase.clear();
            this.rulerBase.lineStyle(1, this.theme.border, 1);
            this.rulerBase.moveTo(0, baseY - 1);
            this.rulerBase.lineTo(this.width, baseY - 1);

            this.rulerTicks.clear();
            this.rulerTicks.lineStyle(1, this.theme.muted, 1);

            let labelCount = 0;
            for (let t = 0; t <= timelineDuration; t += minorStep) {
                const isMajor = Math.abs((t % majorStep)) < 0.01;
                const worldX = sidePadding + (t * zoomScale);
                if (worldX < this.viewportStart - 40 || worldX > this.viewportEnd + 40) continue;
                const x = Math.round(worldX - this.viewportStart) + 0.5;

                const tickHeight = isMajor ? 12 : 5;
                this.rulerTicks.moveTo(x, baseY);
                this.rulerTicks.lineTo(x, baseY - tickHeight);

                if (isMajor && showLabels) {
                    const label = this.getRulerLabel(labelCount);
                    label.visible = true;
                    const labelText = formatTime(t);
                    if (label.text !== labelText) {
                        label.text = labelText;
                    }
                    const nextX = Math.round(x + 4);
                    const nextY = baseY - 12;
                    if (label.x !== nextX) label.x = nextX;
                    if (label.y !== nextY) label.y = nextY;
                    labelCount += 1;
                }
            }

            this.hideUnusedRulerLabels(showLabels ? labelCount : 0);
        }

        /* renderWaveform() ĐÃ BỎ (2026-07-27): sóng âm mọi giai đoạn giờ vẽ bằng
         * AudioWaveform.paintViewport (dữ liệu .pk 750 peak/giây) trên canvas HTML
         * #timelineWaveformCanvas / #editingWaveformCanvas — xem docs/APP_STRUCTURE.md
         * mục "Sóng Âm Thật". Bản Pixi cũ chỉ có 3000 peak cho toàn video, biên độ bị
         * nén sqrt rồi nhân 1.8 nên không phản ánh đúng dB. */

        ensureSegmentNode(index) {
            if (this.segmentPool[index]) {
                return this.segmentPool[index];
            }

            const container = new PIXI.Container();
            const block = new PIXI.Graphics();
            const labelMask = new PIXI.Graphics();
            const label = new PIXI.Text('', {
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: 12,
                fill: 0xffffff,
                align: 'left',
            });

            label.mask = labelMask;
            container.addChild(block);
            container.addChild(labelMask);
            container.addChild(label);

            this.segmentsLayer.addChild(container);
            this.segmentPool[index] = { container, block, label, labelMask };
            return this.segmentPool[index];
        }

        hideUnusedSegmentNodes(fromIndex) {
            for (let i = fromIndex; i < this.segmentPool.length; i += 1) {
                this.segmentPool[i].container.visible = false;
            }
        }

        getAlternatingSegmentColor(mode, item, index) {
            if (mode === 'FINAL') {
                return index % 2 === 0 ? this.theme.success : 0x2fbd79;
            }
            if (mode === 'MAPPED' && item.is_selected) {
                return index % 2 === 0 ? this.theme.success : 0x2fbd79;
            }
            return this.theme.primary;
        }

        drawSingleSegment(node, item, index, layout) {
            const { mode, zoomScale, sidePadding, currentLeftSeq, geometry, viewStart, viewEnd, selectedIndex } = layout;
            const duration = Math.max(0, (item.end - item.start));
            const width = duration * zoomScale;
            if (width <= 0) {
                node.container.visible = false;
                return currentLeftSeq;
            }

            const x = mode === 'FINAL' ? currentLeftSeq : (sidePadding + (item.start * zoomScale));
            const y = geometry.blockTop;
            const h = geometry.blockHeight;

            if ((x + width) < (viewStart - 80) || x > (viewEnd + 80)) {
                node.container.visible = false;
                if (mode === 'FINAL') {
                    return currentLeftSeq + width;
                }
                return currentLeftSeq;
            }

            const color = this.getAlternatingSegmentColor(mode, item, index);
            const isSelected = mode === 'FINAL' && Number(selectedIndex) === index;

            node.container.visible = true;
            node.container.zIndex = index;

            const localX = x - viewStart;
            node.block.clear();
            node.block.beginFill(color, 0.95);
            node.block.lineStyle(isSelected ? 3 : 1, isSelected ? 0xffb020 : color, 1);
            node.block.drawRoundedRect(Math.round(localX), y, width, h, 4);
            node.block.endFill();

            const labelText = item.text || '';
            if (node.label.text !== labelText) {
                node.label.text = labelText;
            }
            node.label.x = Math.round(localX + 8);
            node.label.y = y + 5;
            node.label.visible = width > 16;

            node.labelMask.clear();
            if (width > 8) {
                node.labelMask.beginFill(0xffffff, 1);
                node.labelMask.drawRect(Math.round(localX + 6), y + 2, Math.max(1, width - 12), Math.max(1, h - 4));
                node.labelMask.endFill();
            }

            if (mode === 'FINAL') {
                return currentLeftSeq + width;
            }
            return currentLeftSeq;
        }

        renderSegments({ data, mode, zoomScale, sidePadding, dataVersion = 0, selectedIndex = -1 }) {
            if (!this.app) return;
            const viewportBucket = `${Math.round(this.viewportStart)}:${Math.round(this.viewportEnd)}`;
            const segmentsSignature = [
                mode,
                Math.round(zoomScale * 100),
                Math.round(sidePadding),
                data.length,
                dataVersion,
                selectedIndex,
                data.map((item, index) => [
                    index,
                    Math.round((Number(item.start) || 0) * 1000),
                    Math.round((Number(item.end) || 0) * 1000),
                    item.is_selected ? '1' : '0'
                ].join(':')).join(','),
                this.width,
                this.height,
                viewportBucket,
            ].join('|');
            if (
                segmentsSignature === this.lastSegmentsSignature
                && this.lastSegmentsDataRef === data
            ) {
                return;
            }
            this.lastSegmentsSignature = segmentsSignature;
            this.lastSegmentsDataRef = data;

            const geometry = this.getSegmentGeometry();
            const viewStart = this.viewportStart;
            const viewEnd = this.viewportEnd;

            let currentLeftSeq = sidePadding;

            for (let i = 0; i < data.length; i += 1) {
                const item = data[i];
                const node = this.ensureSegmentNode(i);
                currentLeftSeq = this.drawSingleSegment(node, item, i, {
                    mode,
                    zoomScale,
                    sidePadding,
                    currentLeftSeq,
                    geometry,
                    viewStart,
                    viewEnd,
                    selectedIndex,
                });
            }

            this.hideUnusedSegmentNodes(data.length);
            this.segmentsLayer.sortableChildren = true;
        }

        updateSegment({ index, item, mode, zoomScale, sidePadding, selectedIndex = -1 }) {
            if (!this.app) return;
            if (index < 0) return;
            const node = this.ensureSegmentNode(index);
            const geometry = this.getSegmentGeometry();
            this.drawSingleSegment(node, item, index, {
                mode,
                zoomScale,
                sidePadding,
                currentLeftSeq: sidePadding,
                geometry,
                viewStart: this.viewportStart,
                viewEnd: this.viewportEnd,
                selectedIndex,
            });
        }

        destroy() {
            if (!this.app) return;
            this.app.destroy(true, { children: true, texture: true, baseTexture: true });
            this.app = null;
            this.segmentPool = [];
            this.rulerLabelPool = [];
        }
    }

    window.PixiTimelineRenderer = PixiTimelineRenderer;
})();
