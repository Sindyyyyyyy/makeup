// components/infoForm/infoForm.js - 个人信息表弹窗组件
// 个人中心和首页预约前共用同一份表单，字段只在这里维护一处。
//
// 语言：组件通过 lang 属性决定用哪种语言渲染。顾客端两个宿主传全局语言，
// 后台两个宿主（adminPanel / scheduleGrid）传 'zh' —— 后台不参与翻译，
// 化妆师看到的顾客资料弹窗必须还是中文。
const {
  MAX_PHOTOS,
  GENDER_OPTIONS,
  SKIN_OPTIONS,
  YES_NO_OPTIONS,
  toForm,
  missingFields,
} = require('../../utils/profileInfo');
const { getDict, getLang, tIn, labelIn, listJoinIn } = require('../../utils/i18n.js');

Component({
  options: { addGlobalClass: false },

  properties: {
    visible: { type: Boolean, value: false },
    // 表单当前值（由父页面从云端取好后传入）
    info: { type: Object, value: null },
    // 昵称只读展示用
    nickname: { type: String, value: '' },
    title: { type: String, value: '个人信息' },
    hint: { type: String, value: '' },
    showCancel: { type: Boolean, value: true },
    submitText: { type: String, value: '保存' },
    // 是否要求“填完整”才能提交：预约前置确认用 true，单纯填资料用 false
    requireComplete: { type: Boolean, value: false },
    requirePhoto: { type: Boolean, value: false },
    // 只读查看（化妆师后台看顾客资料）：不可编辑、无保存按钮
    readonly: { type: Boolean, value: false },
    // 渲染语言。留空表示跟随全局语言（顾客端）；后台宿主传 'zh' 固定中文
    lang: { type: String, value: '' },
  },

  data: {
    form: toForm(null, ''),
    missingTip: '',
    submitting: false,
    maxPhotos: MAX_PHOTOS,
    // 整份文案字典，模板里写 {{L.info.xxx}}
    L: {},
    // 选项拆成「值 + 显示标签」两半：
    //   value = 存进数据库的中文原值（男/女、干性/敏感性…），**一个字都不能改**
    //   label = 当前语言下给人看的字（Male/Female、Dry/Sensitive…）
    // 云函数按 value 做白名单校验，动 value 等于改契约。
    genderOptions: [],
    skinOptions: [],
    yesNoOptions: [],
  },

  observers: {
    // 每次打开都用最新的 info 重置，避免上一次没保存完的编辑内容残留。
    // ⚠️ 绝对不要把 lang 挂进这个 observer —— 语言一变就把用户正在填的表清空了。
    'visible, info, nickname': function (visible, info, nickname) {
      if (!visible) return;
      this.setData({ form: toForm(info, nickname), missingTip: '' });
    },
    // 语言单独一个 observer：只换文案，绝不碰 form
    lang: function () {
      this.applyLang();
    },
  },

  ready() {
    this.applyLang();
  },

  methods: {
    // 当前生效的语言：属性优先（后台固定 zh），没给就用全局语言
    curLang() {
      return this.data.lang || getLang();
    },

    // 按语言重刷文案。_appliedLang 是实例字段不是 data —— 放进 data 会在
    // setData 的同时改视图层，ready() 与 observer 都触发时容易打架。
    applyLang() {
      const lang = this.curLang();
      if (this._appliedLang === lang) return;
      this._appliedLang = lang;
      this.setData({
        L: getDict(lang),
        genderOptions: GENDER_OPTIONS.map(v => ({ value: v, label: labelIn(lang, 'gender', v) })),
        skinOptions: SKIN_OPTIONS.map(v => ({ value: v, label: labelIn(lang, 'skin', v) })),
        yesNoOptions: YES_NO_OPTIONS.map(v => ({ value: v, label: labelIn(lang, 'yesno', v) })),
      });
    },

    noop() {},

    onClose() {
      if (this.data.submitting) return;
      this.triggerEvent('close');
    },

    onFormInput(e) {
      if (this.data.readonly) return;
      const field = e.currentTarget.dataset.field;
      if (!field) return;
      this.setData({ [`form.${field}`]: e.detail.value });
    },

    onChipTap(e) {
      if (this.data.readonly) return;
      const { group, value } = e.currentTarget.dataset;
      if (!group) return;
      // 再点一次已选项 = 取消选择
      const next = this.data.form[group] === value ? '' : value;
      const patch = { [`form.${group}`]: next };
      // 改成“无”时清掉过敏说明；肤质不是敏感性时清掉敏感性程度
      if (group === 'hasAllergy' && next !== '有') patch['form.allergyNote'] = '';
      if (group === 'skinType' && next !== '敏感性') patch['form.sensitiveLevel'] = '';
      patch.missingTip = '';
      this.setData(patch);
    },

    async onAddPhoto() {
      if (this.data.readonly) return;
      const lang = this.curLang();
      const remain = MAX_PHOTOS - this.data.form.photos.length;
      if (remain <= 0) {
        wx.showToast({ title: tIn(lang, 'info.maxPhotos', { n: MAX_PHOTOS }), icon: 'none' });
        return;
      }
      try {
        const res = await wx.chooseMedia({
          count: remain,
          mediaType: ['image'],
          sourceType: ['album', 'camera'],
        });
        const files = (res.tempFiles || []).slice(0, remain);
        if (!files.length) return;
        wx.showLoading({ title: tIn(lang, 'common.uploading'), mask: true });
        // 临时路径会被清理，选中后立即上传换 fileID
        const uploaded = [];
        for (let i = 0; i < files.length; i += 1) {
          const f = files[i];
          const ext = ((f.tempFilePath || '').match(/\.(\w+)$/) || [, 'jpg'])[1];
          const cloudPath = `bareface/${Date.now()}-${i}-${Math.floor(Math.random() * 100000)}.${ext}`;
          const up = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath });
          uploaded.push(up.fileID);
        }
        wx.hideLoading();
        this.setData({
          'form.photos': this.data.form.photos.concat(uploaded),
          missingTip: '',
        });
      } catch (err) {
        wx.hideLoading();
        // 用户主动取消不算错误
        if (err && /cancel/i.test(err.errMsg || '')) return;
        console.error('素颜照上传失败', err);
        wx.showToast({ title: tIn(lang, 'info.uploadFailed'), icon: 'none' });
      }
    },

    onDeletePhoto(e) {
      if (this.data.readonly) return;
      const photos = this.data.form.photos.slice();
      photos.splice(e.currentTarget.dataset.idx, 1);
      this.setData({ 'form.photos': photos, missingTip: '' });
    },

    // 点图放大：走系统图片预览，支持左右滑动和双指缩放。
    // readonly 下同样可用——后台看顾客素颜照正是要放大看细节。
    onPreviewPhoto(e) {
      const photos = this.data.form.photos;
      if (!photos.length) return;
      const idx = e.currentTarget.dataset.idx;
      wx.previewImage({
        urls: photos,
        current: photos[idx],
      });
    },

    onSubmit() {
      if (this.data.submitting || this.data.readonly) return;
      const lang = this.curLang();
      const form = this.data.form;
      if (this.data.requireComplete) {
        const missing = missingFields(form, { requirePhoto: this.data.requirePhoto });
        if (missing.length) {
          // 缺项名是规范中文（前后端各有一份，规则必须一致），显示时才翻成英文
          this.setData({ missingTip: tIn(lang, 'common.missing') + listJoinIn(lang, missing) });
          wx.showToast({ title: tIn(lang, 'info.profileIncomplete'), icon: 'none' });
          return;
        }
      }
      // 由父页面决定怎么存、存完做什么（个人中心直接保存，首页还要接着提交预约）
      this.triggerEvent('save', { info: form });
    },

    setSubmitting(v) {
      this.setData({ submitting: !!v });
    },
  },
});