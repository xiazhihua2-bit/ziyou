/* ==================== 指数成分白名单（美股/日股搜索准入） ====================
 * 自选搜索只放行四个指数的成分股：标普500 + 纳斯达克100 + 道琼斯30 + 日经225。
 *
 * 为什么是内置静态快照而不是运行时拉取（实测结论，2026-10-08）：
 *   · 东财 datacenter / push2 系列**没有**全球指数成分接口（RPT_INDEX_COMPONENT 只含 A 股指数；
 *     clist fs=i:100.SPX 只回指数自身；secid 116~135 扫遍无日股）；
 *   · 维基百科（en/zh）在国内网络不可达，Wayback 亦不通；
 *   · nasdaq.com / yahoo 接口无 CORS 或被限流，浏览器里不可用。
 *   因此成分表在构建期由权威源固化进代码，更新成分时重跑下列来源替换本表：
 *     美股：github.com/datasets/s-and-p-500-companies（CSV）+ api.nasdaq.com list-type/nasdaq100
 *     道指：stockanalysis.com/list/dow-jones-stocks/（与标普并集去重）
 *     日股：日经官网 indexes.nikkei.co.jp 成分页 + 中文名人工核对
 * 快照口径 AS_OF：美股 2026-10-07/08；日股为知识快照（个别近期调整可能滞后）。
 *
 * 代码口径与 market.normalize 一致：美股去交易所后缀（BRK.B → BRK），日股 4 位裸码。
 */
XJ.universe = (function () {
  var AS_OF = '2026-10';

  /* 标普500 ∪ 纳斯达克100 ∪ 道琼斯30，去后缀去重（518 只） */
  var US_LIST = ('A AAPL ABBV ABNB ABT ACGL ACN ADBE ADI ADM ADP ADSK AEE AEP AES AFL AIG AIZ AJG AKAM ALAB ALB ALGN ALL ALLE ALNY AMAT AMCR AMD AME AMGN AMP AMT AMZN ANET AON AOS APA APD APH APO APP APTV ARE ARES ARM ASML ATO AVGO AVY AWK AXON AXP AZO BA BAC BALL BAX BBY BDX BE BEN BF BG BIIB BKNG BKR BLK BMY BNY BR BRK BRO BSX BX BXP C CAH CARR CASY CAT CB CBOE CBRE CCEP CCI CCL CDNS CDW CEG CF CFG CHD CHRW CHTR CI CIEN CINF CL CLX CMCSA CME CMG CMI CMS CNC CNP COF COHR COIN COO COP COR COST CPAY CPRT CPT CRH CRL CRM CRWD CRWV CSCO CSGP CSX CTAS CTSH CTVA CVNA CVS CVX D DAL DASH DD DDOG DE DECK DELL DG DGX DHI DHR DIS DLR DLTR DOC DOV DOW DPZ DRI DTE DUK DVA DVN DXCM EBAY ECHO ECL ED EFX EG EIX EL ELV EME EMR EOG EQIX EQT ERIE ES ESS ETN ETR EVRG EW EXC EXE EXPD EXPE EXR F FANG FAST FCX FDS FDX FDXF FE FER FERG FFIV FICO FIS FISV FITB FIX FLEX FOX FOXA FRT FSLR FTNT FTV GD GDDY GE GEHC GEN GEV GILD GIS GL GLW GM GNRC GOOG GOOGL GPC GPN GRMN GS GWW HAL HAS HBAN HCA HD HIG HII HLT HON HONA HOOD HPE HPQ HRL HSIC HST HSY HUBB HUM HWM IBKR IBM ICE IDXX IEX IFF ILMN INCY INTC INTU INVH IP IQV IR IRM ISRG IT ITW IVZ J JBHT JBL JCI JKHY JNJ JPM KDP KEY KEYS KHC KIM KKR KLAC KMB KMI KO KR KVUE L LDOS LEN LH LHX LII LIN LITE LLY LMT LNT LOW LRCX LULU LUV LVS LYB LYV MA MAA MAR MAS MCD MCHP MCK MCO MDLZ MDT MELI MET META MGM MKC MLM MMM MNST MO MOS MPC MPWR MRK MRNA MRSH MRVL MS MSCI MSFT MSI MSTR MTB MTD MU NBIS NCLH NDAQ NDSN NEE NEM NFLX NI NKE NOC NOW NRG NSC NTAP NTRS NUE NVDA NVR NWS NWSA NXPI O ODFL OKE OMC ON ORCL ORLY OTIS OXY P PANW PAYX PCAR PCG PDD PEG PEP PFE PFG PG PGR PH PHM PKG PLD PLTR PM PNC PNR PNW PODD PPG PPL PRU PSA PSKY PSX PTC PWR PYPL Q QCOM RCL RDDT REG REGN RF RJF RKLB RL RMD ROK ROL ROP ROST RSG RTX RVTY SBAC SBUX SCHW SHOP SHW SJM SLB SMCI SNA SNDK SNPS SO SOLV SPCX SPG SPGI SRE STE STLD STT STX STZ SW SWK SWKS SYF SYK SYY T TDG TDY TECH TEL TER TFC TGT TJX TKO TMO TMUS TPL TPR TRGP TRI TRMB TROW TRV TSCO TSLA TSN TT TTWO TXN TXT TYL UAL UBER UDR UHS ULTA UNH UNP UPS URI USB V VEEV VICI VLO VLTO VMC VMRK VRSK VRSN VRT VRTX VST VTR VTRS VZ WAB WAT WBD WDAY WDC WEC WELL WFC WM WMB WMT WRB WSM WST WTW WY WYNN XEL XOM XYL XYZ YUM ZBH ZBRA ZTS').split(' ');

  /* 日经225（代码 + 中文名；中文名供本地搜索匹配，腾讯联想不覆盖日股） */
  var JP_LIST = [
    ['1801', '大成建设'], ['1802', '大林组'], ['1803', '清水建设'], ['1812', '鹿岛建设'],
    ['1925', '大和房屋'], ['1926', '积水房屋'], ['1928', '积水化学'],
    ['2002', '日清制粉集团'], ['2269', '明治控股'], ['2282', '日本火腿'], ['2502', '朝日集团'], ['2503', '麒麟控股'],
    ['2531', '味之素'], ['2801', '龟甲万'], ['2871', '日清食品'], ['2874', '日冷'],
    ['3101', '东洋纺'], ['3105', '日清纺控股'], ['3289', '东急不动产'], ['3382', '7&i控股'],
    ['3401', '帝人'], ['3402', '东丽'], ['3405', '库拉雷'], ['3407', '旭化成'],
    ['3861', '王子控股'], ['3863', '日本制纸'],
    ['4004', 'Resonac'], ['4005', '住友化学'], ['4021', '日产化学'], ['4042', '东曹'], ['4043', '德山'],
    ['4063', '信越化学'], ['4183', '三井化学'], ['4188', '三菱化学'], ['4203', '住友电木'], ['4205', 'Zeon'], ['4208', '宇部'],
    ['4324', '电通集团'], ['4502', '武田药品'], ['4503', '安斯泰来'], ['4506', '住友制药'], ['4507', '盐野义'],
    ['4519', '中外制药'], ['4523', '卫材'], ['4543', '泰尔茂'], ['4568', '第一三共'], ['4578', '大冢控股'],
    ['4661', '东方乐园'], ['4704', '趋势科技'], ['4755', '乐天集团'],
    ['4901', '富士胶片'], ['4902', '柯尼卡美能达'], ['4911', '资生堂'],
    ['5019', '出光兴产'], ['5020', 'ENEOS'],
    ['5101', '横滨橡胶'], ['5108', '普利司通'], ['5110', '住友橡胶'],
    ['5201', 'AGC'], ['5202', '日本板硝子'], ['5232', '住友大阪水泥'], ['5233', '太平洋水泥'],
    ['5301', '东海碳素'], ['5332', 'TOTO'], ['5333', 'NGK绝缘子'], ['5334', 'Niterra'],
    ['5401', '日本制铁'], ['5406', '神户制钢'], ['5411', 'JFE控股'],
    ['5631', '日本制钢所'],
    ['5706', '三井金属'], ['5711', '三菱材料'], ['5713', '住友金属矿山'], ['5714', 'Dowa'],
    ['5801', '古河电工'], ['5802', '住友电工'], ['5803', '藤仓'],
    ['5938', 'Lixil'],
    ['6098', 'Recruit'], ['6113', 'Amada'], ['6141', 'DMG森精机'], ['6178', '日本邮政'],
    ['6268', '纳博特斯克'], ['6273', 'SMC'],
    ['6301', '小松'], ['6302', '住友重机械'], ['6305', '日立建机'], ['6326', '久保田'],
    ['6361', '荏原'], ['6367', '大金工业'], ['6383', '大福'],
    ['6448', '兄弟工业'], ['6460', '世嘉三美'], ['6471', '日本精工'], ['6472', 'NTN'], ['6473', '捷太格特'],
    ['6479', '美蓓亚三美'], ['6481', 'THK'],
    ['6501', '日立'], ['6502', '东芝'], ['6503', '三菱电机'], ['6504', '富士电机'], ['6506', '安川电机'],
    ['6594', '尼得科'],
    ['6645', '欧姆龙'], ['6701', 'NEC'], ['6702', '富士通'], ['6723', '瑞萨电子'], ['6724', '精工爱普生'],
    ['6752', '松下'], ['6753', '夏普'], ['6758', '索尼集团'], ['6762', 'TDK'], ['6770', '阿尔卑斯阿尔派'],
    ['6841', '横河电机'], ['6857', '爱德万测试'], ['6869', '希森美康'],
    ['6902', '电装'], ['6952', '卡西欧'], ['6954', '发那科'], ['6963', '罗姆'], ['6971', '京瓷'],
    ['6976', '太阳诱电'], ['6981', '村田制作'], ['6988', '日东电工'],
    ['7011', '三菱重工'], ['7012', '川崎重工'], ['7013', 'IHI'],
    ['7201', '日产'], ['7202', '五十铃'], ['7203', '丰田'], ['7205', '日野'], ['7211', '三菱汽车'],
    ['7261', '马自达'], ['7267', '本田'], ['7269', '铃木'], ['7270', '斯巴鲁'], ['7272', '雅马哈发动机'],
    ['7309', '禧玛诺'],
    ['7550', '食其家'],
    ['7701', '岛津'], ['7731', '尼康'], ['7732', '拓普康'], ['7733', '奥林巴斯'], ['7735', 'Screen'],
    ['7741', '豪雅'], ['7751', '佳能'], ['7752', '理光'], ['7794', 'Kokusai Electric'],
    ['7832', '万代南梦宫'], ['7911', 'Toppan'], ['7912', '大日本印刷'], ['7936', '亚瑟士'],
    ['7951', '雅马哈'], ['7974', '任天堂'],
    ['8001', '伊藤忠'], ['8002', '丸红'], ['8015', '丰田通商'], ['8031', '三井物产'],
    ['8035', '东京电子'], ['8053', '住友商事'], ['8058', '三菱商事'],
    ['8113', '尤妮佳'],
    ['8253', 'Credit Saison'], ['8267', '永旺'],
    ['8306', '三菱UFJ'], ['8308', 'Resona'], ['8309', '三井住友信托'], ['8316', '三井住友'],
    ['8331', '千叶银行'], ['8411', '瑞穗'],
    ['8439', 'Tokyo Century'],
    ['8591', '欧力士'], ['8593', '三菱HC资本'],
    ['8601', '大和证券'], ['8604', '野村'], ['8630', 'Sompo'], ['8697', '日本交易所'],
    ['8725', 'MS&AD'], ['8750', '第一生命'], ['8766', '东京海上'],
    ['8801', '三井不动产'], ['8802', '三菱地所'], ['8804', '东京建物'], ['8830', '住友不动产'],
    ['9001', '东武铁道'], ['9005', '京成电铁'], ['9007', '小田急'], ['9020', 'JR东日本'],
    ['9021', 'JR西日本'], ['9022', 'JR东海'], ['9023', '东京地铁'], ['9041', '近铁集团'], ['9042', '阪急阪神'],
    ['9062', '日本通运'], ['9064', '大和运输'],
    ['9101', '日本邮船'], ['9104', '商船三井'], ['9107', '川崎汽船'],
    ['9201', '日本航空'], ['9202', '全日空'],
    ['9401', 'TBS'], ['9404', '日本电视台'],
    ['9432', 'NTT'], ['9433', 'KDDI'], ['9434', '软银'], ['9468', 'KADOKAWA'],
    ['9501', '东京电力'], ['9502', '中部电力'], ['9503', '关西电力'], ['9504', '中国电力'], ['9505', '北陆电力'],
    ['9506', '东北电力'], ['9507', '九州电力'], ['9508', '四国电力'], ['9509', '北海道电力'],
    ['9513', 'J-POWER'], ['9531', '东京燃气'], ['9532', '大阪燃气'], ['9533', '东邦燃气'],
    ['9613', 'NTT数据'], ['9684', 'Square Enix'],
    ['9766', '科乐美'], ['9843', '宜得利'],
    ['9983', '迅销'], ['9984', '软银集团'],
  ];

  var usMap = null, jpMap = null;
  function init() {
    if (usMap) return;
    usMap = {};
    US_LIST.forEach(function (t) { usMap[t] = 1; });
    jpMap = {};
    JP_LIST.forEach(function (r) { jpMap[r[0]] = r[1]; });
  }

  function hasUs(sym) {
    init();
    return String(sym || '').slice(0, 2) === 'us' && !!usMap[String(sym).slice(2).toUpperCase()];
  }
  function hasJp(sym) {
    init();
    return String(sym || '').slice(0, 2) === 'jp' && jpMap[String(sym).slice(2)] !== undefined;
  }
  function jpName(code) { init(); return jpMap[String(code)] || ''; }

  /**
   * 本地匹配（腾讯联想不覆盖日股，这是日股进搜索列表的唯一入口；
   * 美股作为联想失败时的兜底）。名称包含或代码前缀匹配，最多 20 条。
   */
  function searchLocal(kw) {
    init();
    var k = String(kw || '').trim();
    if (!k) return [];
    var ku = k.toUpperCase();
    var out = [];
    JP_LIST.forEach(function (r) {
      if (out.length >= 20) return;
      if (r[0].indexOf(k) === 0 || r[1].indexOf(k) >= 0) {
        out.push({ symbol: 'jp' + r[0], code: r[0], market: 'jp', name: r[1], pinyin: '', type: '', kind: '日股' });
      }
    });
    if (/^[A-Za-z]/.test(k)) {
      US_LIST.forEach(function (t) {
        if (out.length >= 20) return;
        if (t.indexOf(ku) === 0) out.push({ symbol: 'us' + t, code: t, market: 'us', name: t, pinyin: '', type: '', kind: '美股' });
      });
    }
    return out;
  }

  /** 预留的异步签名：当前为纯本地快照，立即回调；将来换运行时源不必改调用方 */
  function ensure(cb) { init(); if (cb) cb(); }

  return {
    AS_OF: AS_OF,
    hasUs: hasUs, hasJp: hasJp, jpName: jpName,
    searchLocal: searchLocal, ensure: ensure,
    counts: function () { init(); return { us: US_LIST.length, jp: JP_LIST.length }; },
  };
})();
