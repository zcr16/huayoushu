import { FloatingLedgerService } from './FloatingLedgerService';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

interface PetAction {
  id: string;
  title: string;
  icon: string;
  track: string;
  frames: number;
  line: string;
}

// Local sprite animation, props and preferences only. Capture is a separate button.
@Entry
@Component
struct PetActions {
  @State private appearance: string = 'whale';
  @State private interacting: boolean = false;
  @State private choosing: boolean = false;
  @State private busy: boolean = false;
  @State private saving: boolean = false;
  @State private settingsReady: boolean = false;
  @State private bubble: string = '在呢，今天也陪你把账理清。';
  @State private motion: string = 'idle';
  @State private frame: number = 0;
  @State private playing: string = '';
  @State private phase: number = 0;
  @State private tilt: number = 0;
  @State private lift: number = 0;
  @State private shift: number = 0;
  @State private zoom: number = 1;
  @State private hint: string = '';
  @State private selectionHint: string = '';
  @State private favorites: string[] = ['rice', 'pat', 'wave', 'flowers'];
  @State private draft: string[] = [];
  @State private choicePage: number = 0;
  private timer: number = -1;
  private motionGeneration: number = 0;
  private alive: boolean = false;
  private store: preferences.Preferences | undefined = undefined;
  private service: FloatingLedgerService = FloatingLedgerService.shared;
  private menuListener: () => void = () => {
    this.stopMotion();
    this.interacting = false;
    this.choosing = false;
    this.appearance = this.service.getAppearance();
  };
  private actions: PetAction[] = [
    { id: 'rice', title: '炫白饭', icon: '🍚', track: 'review', frames: 6, line: '啊呜！白饭也要吃得香香的。' },
    { id: 'snack', title: '吃零食', icon: '🍪', track: 'running', frames: 6, line: '咔嚓咔嚓，快乐补给到位！' },
    { id: 'fish', title: '摸鱼', icon: '🐟', track: 'waiting', frames: 6, line: '嘘——让我偷偷摸两秒鱼。' },
    { id: 'rest', title: '躺平', icon: '💤', track: 'failed', frames: 8, line: '电量低低，先躺一小会儿。' },
    { id: 'flowers', title: '撒花', icon: '🌸', track: 'wave', frames: 4, line: '给认真生活的你，撒花！' },
    { id: 'jump', title: '开心跳', icon: '✨', track: 'jump', frames: 5, line: '今天的快乐，向上蹦三格！' },
    { id: 'spin', title: '转圈圈', icon: '🌀', track: 'running', frames: 6, line: '转一圈，把烦恼甩出去～' },
    { id: 'cheer', title: '加油', icon: '🚩', track: 'running', frames: 6, line: '加油加油！我给你当啦啦队。' },
    { id: 'ledger', title: '翻账本', icon: '📒', track: 'review', frames: 6, line: '小账本翻开啦，今天也井井有条。' },
    { id: 'pat', title: '摸摸头', icon: '💗', track: 'jump', frames: 5, line: '摸摸头，收到啦～' },
    { id: 'wave', title: '挥挥手', icon: '👋', track: 'wave', frames: 4, line: '嗨～我一直在这儿。' },
    { id: 'run', title: '左右小跑', icon: '💨', track: 'run-right', frames: 8, line: '左边看看，右边看看，出发！' },
    { id: 'wait', title: '等你呀', icon: '☕', track: 'idle', frames: 6, line: '热茶泡好啦，慢慢来，我等你。' },
    { id: 'idea', title: '灵光一闪', icon: '💡', track: 'review', frames: 6, line: '叮！想到一个好主意。' }
  ];

  aboutToAppear(): void {
    this.alive = true;
    this.appearance = this.service.getAppearance();
    this.loadFavorites();
    this.service.setMenuListener(this.menuListener);
  }

  aboutToDisappear(): void {
    this.alive = false;
    this.stopMotion();
    this.service.clearMenuListener(this.menuListener);
  }

  private name(): string {
    return this.appearance === 'star' ? 'Claude' : this.appearance === 'robot' ? 'GPT' : '鲸鱼娘';
  }

  private action(id: string): PetAction {
    const found = this.actions.find((item: PetAction) => item.id === id);
    return found ? found : this.actions[10];
  }

  private validFavorites(value: string[]): boolean {
    if (!Array.isArray(value) || value.length < 2 || value.length > 6) return false;
    const unique: string[] = [];
    for (const id of value) {
      if (typeof id !== 'string' || unique.includes(id) || !this.actions.some((item: PetAction) => item.id === id)) return false;
      unique.push(id);
    }
    return true;
  }

  private async loadFavorites(): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const store = await preferences.getPreferences(context, { name: 'huayoushu_pet_actions' });
      if (!this.alive) return;
      this.store = store;
      const raw = store.getSync('favorites_v1', '');
      if (typeof raw === 'string' && raw.length <= 256) {
        try {
          const parsed = JSON.parse(raw) as string[];
          if (this.validFavorites(parsed)) this.favorites = parsed.slice();
        } catch {}
      }
    } catch {
      // Defaults remain usable; failed persistence is reported if the user saves.
    } finally {
      if (this.alive) this.settingsReady = true;
    }
  }

  private openChoices(): void {
    this.stopMotion();
    this.draft = this.favorites.slice();
    this.selectionHint = '';
    this.choicePage = 0;
    this.choosing = true;
  }

  private toggleFavorite(id: string): void {
    if (this.saving) return;
    if (this.draft.includes(id)) {
      this.draft = this.draft.filter((value: string) => value !== id);
      this.selectionHint = '';
    } else if (this.draft.length < 6) {
      this.draft = this.draft.concat(id);
      this.selectionHint = '';
    } else {
      this.selectionHint = '最多选6个，先取消一个再选。';
    }
  }

  private async saveFavorites(): Promise<void> {
    if (this.saving || !this.validFavorites(this.draft)) return;
    this.saving = true;
    const selected = this.draft.slice();
    try {
      if (!this.store) {
        const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
        this.store = await preferences.getPreferences(context, { name: 'huayoushu_pet_actions' });
      }
      await this.store.put('favorites_v1', JSON.stringify(selected));
      await this.store.flush();
      if (this.alive) {
        this.favorites = selected;
        this.stopMotion();
        this.choosing = false;
        this.bubble = '常用动作记住啦，随时点我玩。';
      }
    } catch {
      if (this.alive) this.selectionHint = '暂时没保存成功，请再试一次。';
    } finally {
      if (this.alive) this.saving = false;
    }
  }

  private stopMotion(): void {
    ++this.motionGeneration;
    if (this.timer !== -1) clearTimeout(this.timer);
    this.timer = -1;
    this.motion = 'idle';
    this.frame = 0;
    this.playing = '';
    this.phase = 0;
    this.tilt = 0;
    this.lift = 0;
    this.shift = 0;
    this.zoom = 1;
  }

  private playAction(id: string): void {
    this.stopMotion();
    const action = this.action(id);
    this.playing = action.id;
    this.bubble = action.line;
    this.motion = action.track;
    this.advanceAction(action, 0, this.motionGeneration);
  }

  private advanceAction(action: PetAction, step: number, generation: number): void {
    // Exactly one bounded sequence, never a background animation loop.
    const steps = action.id === 'run' ? 16 : 8;
    if (step >= steps) { this.stopMotion(); return; }
    this.phase = step / (steps - 1);
    this.motion = action.id === 'run' ? (step < 8 ? 'run-right' : 'run-left') : action.track;
    this.frame = action.id === 'run' ? step % 8 : Math.min(action.frames - 1, Math.floor(step * action.frames / steps));
    const bounce = step % 2 === 0;
    this.tilt = 0;
    this.lift = 0;
    this.shift = 0;
    this.zoom = 1;
    if (action.id === 'spin') this.tilt = this.phase * 360;
    if (action.id === 'rest') { this.tilt = Math.min(74, step * 24); this.lift = 15; this.zoom = 0.86; }
    if (action.id === 'run') this.shift = step < 8 ? -18 + step * 5 : 18 - (step - 8) * 5;
    if (action.id === 'fish') this.tilt = bounce ? -5 : 5;
    if (action.id === 'rice' || action.id === 'snack') { this.tilt = bounce ? -4 : 4; this.zoom = bounce ? 1.03 : 0.98; }
    if (action.id === 'cheer' || action.id === 'jump') this.lift = bounce ? -8 : 0;
    if (action.id === 'pat') this.zoom = bounce ? 0.96 : 1.04;
    if (action.id === 'wave' && this.appearance !== 'whale') this.tilt = bounce ? -8 : 8;
    if (action.id === 'idea') this.zoom = bounce ? 1.03 : 1;
    this.timer = setTimeout(() => {
      this.timer = -1;
      if (generation !== this.motionGeneration || !this.alive || !this.service.isMenuVisible()) return;
      this.advanceAction(action, step + 1, generation);
    }, action.id === 'run' ? 120 : 240);
  }

  private async capture(): Promise<void> {
    if (this.busy) return;
    this.stopMotion();
    this.busy = true;
    this.hint = '';
    try { await this.service.captureFromMenu(); }
    catch { this.hint = '没有截取成功，请再试一次；也可回花有数选付款截图。'; }
    finally { this.busy = false; }
  }

  @Builder
  private petImage(size: number) {
    if (this.appearance === 'whale') {
      Image($rawfile('assistants/motion/whale-' + this.motion + '-' + this.frame.toString() + '.png'))
        .width(size).height(size * 208 / 192).objectFit(ImageFit.Contain)
        .rotate({ angle: this.tilt }).translate({ x: this.shift, y: this.lift })
        .scale({ x: this.zoom, y: this.zoom }).animation({ duration: 140, curve: Curve.EaseInOut })
        .accessibilityText('鲸鱼娘')
    } else {
      Image($rawfile('assistants/' + this.appearance + '.png'))
        .width(size).height(size * 208 / 192).objectFit(ImageFit.Contain)
        .rotate({ angle: this.tilt }).translate({ x: this.shift, y: this.lift })
        .scale({ x: this.zoom, y: this.zoom }).animation({ duration: 140, curve: Curve.EaseInOut })
        .accessibilityText(this.name())
    }
  }

  @Builder
  private petStage(size: number) {
    Stack({ alignContent: Alignment.Center }) {
      this.petImage(size)
      if (this.playing === 'rice' || this.playing === 'snack') {
        Text(this.playing === 'rice' ? '🍚' : '🍪').fontSize(size * 0.33)
          .translate({ x: size * 0.18, y: size * (this.frame % 2 === 0 ? 0.20 : 0.08) })
          .rotate({ angle: this.frame % 2 === 0 ? -8 : 10 }).animation({ duration: 170 })
        Text(this.playing === 'rice' ? '• · •' : '· •').fontSize(size * 0.17).fontColor('#FFF9DB')
          .shadow({ radius: 1, color: '#9B835C', offsetY: 1 })
          .translate({ x: size * 0.08, y: -size * 0.06 - this.phase * 12 })
          .opacity(this.frame % 2 === 0 ? 1 : 0.3)
      } else if (this.playing === 'flowers') {
        Text('🌸').fontSize(size * 0.24).translate({ x: -size * this.phase * 0.4, y: -size * this.phase * 0.6 })
        Text('🌼').fontSize(size * 0.21).translate({ x: size * this.phase * 0.4, y: -size * this.phase * 0.45 })
        Text('✦').fontSize(size * 0.22).fontColor('#EBC16A').translate({ x: size * 0.30, y: -size * this.phase * 0.8 })
      } else if (this.playing === 'fish') {
        Text('🐟').fontSize(size * 0.29).translate({ x: -size * 0.4 + size * this.phase * 0.8, y: size * 0.32 })
          .rotate({ angle: this.frame % 2 === 0 ? -10 : 10 })
      } else if (this.playing === 'rest') {
        Text('Z z z').fontSize(size * 0.16).fontColor('#6E8DB5')
          .translate({ x: size * 0.22, y: -size * (0.20 + this.phase * 0.2) })
      } else if (this.playing === 'ledger') {
        Text(this.frame % 2 === 0 ? '📒' : '📖').fontSize(size * 0.37)
          .translate({ x: size * 0.10, y: size * 0.19 }).rotate({ angle: this.frame % 2 === 0 ? -9 : 9 })
      } else if (this.playing === 'cheer') {
        Text('🚩').fontSize(size * 0.30).translate({ x: size * 0.34, y: -size * 0.20 })
          .rotate({ angle: this.frame % 2 === 0 ? -18 : 18 })
        Text('加油!').fontSize(size * 0.14).fontColor('#D87347').fontWeight(FontWeight.Bold)
          .translate({ x: -size * 0.25, y: -size * 0.35 })
      } else if (this.playing === 'idea') {
        Text('💡').fontSize(size * 0.30).translate({ x: size * 0.26, y: -size * 0.32 })
          .scale({ x: this.frame % 2 === 0 ? 1.15 : 0.9, y: this.frame % 2 === 0 ? 1.15 : 0.9 })
      } else if (this.playing === 'pat') {
        Text('💗').fontSize(size * 0.24).translate({ x: size * 0.25, y: -size * (0.25 + this.phase * 0.3) })
      } else if (this.playing === 'wait') {
        Text('☕').fontSize(size * 0.28).translate({ x: size * 0.30, y: size * 0.26 })
        Text('～').fontSize(size * 0.18).fontColor('#ADAAA0').translate({ x: size * 0.30, y: -this.phase * size * 0.25 })
      } else if (this.playing === 'jump' || this.playing === 'spin' || this.playing === 'run') {
        Text(this.playing === 'run' ? '💨' : '✨').fontSize(size * 0.22)
          .translate({ x: -size * 0.30, y: size * 0.18 }).opacity(this.frame % 2 === 0 ? 1 : 0.45)
      }
    }.width(size + 12).height(size * 1.14)
  }

  @Builder
  private actionMenu() {
    Row({ space: 10 }) {
      this.petImage(38)
      Column({ space: 3 }) {
        Text(this.name()).fontSize(16).fontWeight(FontWeight.Medium).fontColor('#193D34')
        Text('今天想做什么？').fontSize(12).fontColor('#718179')
      }.alignItems(HorizontalAlign.Start)
      Blank()
    }.width('100%')
    Button({ type: ButtonType.Normal }) {
      Column({ space: 5 }) {
        Text(this.busy ? '正在截图…' : '截图记账').fontSize(21).fontWeight(FontWeight.Bold).fontColor(Color.White)
        Text('识别当前页面 · 多笔查重').fontSize(12).fontColor('#DEEEE8')
      }.width('100%')
    }.width('100%').height(76).borderRadius(18).backgroundColor('#176D57')
    .enabled(!this.busy).margin({ top: 13 }).onClick(() => { this.capture(); })
    Row() {
      Blank()
      Button('和我互动', { type: ButtonType.Normal })
        .width(142).height(44).fontSize(15).fontColor('#285C4C').backgroundColor('#EAF2EC').borderRadius(14)
        .enabled(!this.busy).onClick(() => {
          this.interacting = true;
          this.choosing = false;
          this.playAction('wave');
        })
    }.width('100%').margin({ top: 10 })
    Text(this.hint.length > 0 ? this.hint : '只在点“截图记账”后取画面。')
      .fontSize(11).fontColor('#7A8880').margin({ top: 12 }).width('100%')
  }

  @Builder
  private favoriteButton(id: string) {
    Button(this.action(id).icon + ' ' + this.action(id).title, { type: ButtonType.Normal })
      .height(36).layoutWeight(1).fontSize(13).fontColor('#285C4C')
      .backgroundColor(this.playing === id ? '#D6EADB' : '#EAF2EC').borderRadius(12)
      .onClick(() => { this.playAction(id); })
  }

  @Builder
  private interactionPanel() {
    Row() {
      Text(this.name()).fontSize(16).fontWeight(FontWeight.Medium).fontColor('#193D34')
      Blank()
      Button('返回菜单', { type: ButtonType.Normal }).height(28).fontSize(12)
        .fontColor('#356251').backgroundColor('#EAF2EC').borderRadius(10)
        .onClick(() => { this.stopMotion(); this.interacting = false; })
    }.width('100%')
    Row({ space: 6 }) {
      Column() { this.petStage(92) }.onClick(() => { this.playAction('pat'); })
        .accessibilityText('摸摸' + this.name() + '的头')
      Text(this.bubble).fontSize(12).lineHeight(19).fontColor('#2D5D4B')
        .padding(9).backgroundColor('#EDF4ED').borderRadius(14).layoutWeight(1)
    }.width('100%').margin({ top: 5, bottom: 6 })
    ForEach([0, 2, 4], (start: number) => {
      if (start < this.favorites.length) {
        Row({ space: 8 }) {
          this.favoriteButton(this.favorites[start])
          if (start + 1 < this.favorites.length) { this.favoriteButton(this.favorites[start + 1]) }
          else { Blank().layoutWeight(1) }
        }.width('100%').margin({ bottom: 6 })
      }
    }, (start: number) => start.toString() + ':' + this.favorites.slice(start, start + 2).join(','))
    Button(this.settingsReady ? '自选动作 · 14种' : '正在读取常用动作…', { type: ButtonType.Normal })
      .height(30).width('100%').fontSize(12).fontColor('#527463').backgroundColor('#F3F5EE').borderRadius(10)
      .enabled(this.settingsReady).onClick(() => { this.openChoices(); })
    Text('小互动 · 不截图、不联网').fontSize(10).fontColor('#7A8880').margin({ top: 6 })
  }

  @Builder
  private choiceCell(index: number) {
    if (index < this.actions.length) {
      Row({ space: 0 }) {
        Button(this.actions[index].icon + ' ' + this.actions[index].title, { type: ButtonType.Normal })
          .height(34).layoutWeight(1).fontSize(12).fontColor('#285C4C').backgroundColor(Color.Transparent)
          .onClick(() => { this.playAction(this.actions[index].id); })
        Button(this.draft.includes(this.actions[index].id) ? '★' : '☆', { type: ButtonType.Normal })
          .width(28).height(34).padding(0).fontSize(20)
          .fontColor(this.draft.includes(this.actions[index].id) ? '#C99835' : '#9CA79D')
          .backgroundColor(Color.Transparent).enabled(!this.saving)
          .accessibilityText((this.draft.includes(this.actions[index].id) ? '取消常用' : '设为常用') + this.actions[index].title)
          .onClick(() => { this.toggleFavorite(this.actions[index].id); })
      }.layoutWeight(1).backgroundColor('#EAF2EC').borderRadius(10)
    } else { Blank().layoutWeight(1) }
  }

  @Builder
  private choicesPanel() {
    Row() {
      Text('自选常用动作').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#193D34')
      Blank()
      Button('取消', { type: ButtonType.Normal }).height(28).fontSize(12).fontColor('#527463')
        .backgroundColor('#EAF2EC').borderRadius(10).enabled(!this.saving)
        .onClick(() => { this.stopMotion(); this.choosing = false; })
    }.width('100%')
    Row({ space: 6 }) {
      this.petStage(54)
      Text(this.playing.length > 0 ? this.bubble : '点动作试看，点☆选常用。')
        .fontSize(11).lineHeight(17).fontColor('#527463').layoutWeight(1)
    }.width('100%').margin({ top: 4, bottom: 4 })
    Text(this.selectionHint.length > 0 ? this.selectionHint : '已选 ' + this.draft.length.toString() + '/6 · 请选2–6个')
      .fontSize(11).fontColor(this.selectionHint.length > 0 ? '#B36D36' : '#718179').margin({ bottom: 6 })
    ForEach([0, 2, 4], (start: number) => {
      Row({ space: 7 }) {
        this.choiceCell(this.choicePage * 6 + start)
        this.choiceCell(this.choicePage * 6 + start + 1)
      }.width('100%').margin({ bottom: 5 })
    }, (start: number) => this.choicePage.toString() + ':' + start.toString())
    Row() {
      Button('‹ 上页', { type: ButtonType.Normal }).height(28).fontSize(12)
        .fontColor('#527463').backgroundColor(Color.Transparent).enabled(this.choicePage > 0)
        .onClick(() => { this.choicePage -= 1; })
      Blank()
      Text((this.choicePage + 1).toString() + '/3').fontSize(11).fontColor('#718179')
      Blank()
      Button('下页 ›', { type: ButtonType.Normal }).height(28).fontSize(12)
        .fontColor('#527463').backgroundColor(Color.Transparent).enabled(this.choicePage < 2)
        .onClick(() => { this.choicePage += 1; })
    }.width('100%')
    Button(this.saving ? '正在保存…' : '保存常用动作', { type: ButtonType.Normal })
      .height(36).width('100%').fontSize(13).fontColor(Color.White).backgroundColor('#176D57').borderRadius(12)
      .enabled(!this.saving && this.validFavorites(this.draft)).onClick(() => { this.saveFavorites(); })
  }

  build() {
    Column() {
      // Keep controls below the system title bar even when content scrolls.
      Blank().height(44).flexShrink(0)
      Scroll() {
        Column() {
          if (this.choosing) { this.choicesPanel() }
          else if (this.interacting) { this.interactionPanel() }
          else { this.actionMenu() }
        }.width('100%').padding({ left: 14, right: 14, bottom: 6 }).alignItems(HorizontalAlign.Start)
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off)
      Text('左上角收起 · ×关闭助手').fontSize(10).fontColor('#7A8880')
        .height(22).width('100%').textAlign(TextAlign.Center).flexShrink(0)
    }.width('100%').height('100%').backgroundColor('#FCFCF8')
  }
}
