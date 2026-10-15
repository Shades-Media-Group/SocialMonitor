/**
 * The words of the emails SocialMonitor sends, in each dashboard language. {placeholders} are
 * filled in by mailText; mail.ts lays them out in Gradient's email design. Keep every language's
 * set complete: a missing key falls back to English.
 */
export type MailLang = 'en' | 'ro' | 'ru' | 'fr' | 'zh'
type Key =
  | 'codeSubject'
  | 'codeHeading'
  | 'codeLabel'
  | 'codeValid'
  | 'codeStub'
  | 'resetCodeSubject'
  | 'resetCodeHeading'
  | 'resetCodeLabel'
  | 'resetCodeStub'
  | 'inviteSubject'
  | 'inviteHeading'
  | 'inviteLead'
  | 'inviteButton'
  | 'inviteNote'
  | 'resetSubject'
  | 'resetHeading'
  | 'resetButton'
  | 'resetNote'
  | 'forgotNote'
  | 'accessSubject'
  | 'accessHeading'
  | 'accessLead'
  | 'everyBrand'
  | 'badSubject'
  | 'badHeading'
  | 'badLead'
  | 'instantSubject'
  | 'instantHeading'
  | 'instantLead'
  | 'instantUrgent'
  | 'instantRun'
  | 'instantWatched'
  | 'instantMore'
  | 'digestWeekSubject'
  | 'digestMonthSubject'
  | 'digestWeekHeading'
  | 'digestMonthHeading'
  | 'digestLead'
  | 'digestNew'
  | 'digestComplaints'
  | 'digestQuestions'
  | 'digestPraise'
  | 'digestReply'
  | 'digestPdf'
  | 'open'
  | 'orCopy'
  | 'credit'

const TEXT: Record<MailLang, Record<Key, string>> = {
  en: {
    codeSubject: '{code} is your SocialMonitor sign-in code',
    codeHeading: 'Your sign-in code',
    codeLabel: 'Sign-in code',
    codeValid: 'Works for 10 minutes',
    codeStub: 'If you did not just sign in, change your password: someone knows it.',
    resetCodeSubject: '{code} is your SocialMonitor password code',
    resetCodeHeading: 'Your code to change your password',
    resetCodeLabel: 'Password code',
    resetCodeStub:
      'If you did not ask to change your password, ignore this email. Your password stays as it is.',
    inviteSubject: '{from} invited you to SocialMonitor',
    inviteHeading: 'You are invited',
    inviteLead: '{from} gave you access to SocialMonitor. Choose your password to start.',
    inviteButton: 'Choose your password',
    inviteNote: 'The link works once, for 72 hours.',
    resetSubject: 'Set a new SocialMonitor password',
    resetHeading: 'Set a new password',
    resetButton: 'Choose a new password',
    resetNote: 'The link works once, for 30 minutes.',
    forgotNote:
      'The link works once, for 30 minutes. If you did not ask for it, ignore this email.',
    accessSubject: 'You have new access in SocialMonitor',
    accessHeading: 'New access',
    accessLead: '{from} gave you access to {brands}. Sign in to see it.',
    everyBrand: 'every brand',
    badSubject: '{brand}: {n} negative comments',
    badHeading: '{n} negative comments',
    badLead: 'The attached PDF lists {n} negative comments about {brand}, grouped by kind.',
    instantSubject: '{brand}: {n} comments need you now',
    instantHeading: '{n} comments need you now',
    instantLead: 'The last update of {brand} found these. Each comment is sent once.',
    instantUrgent: 'Urgent',
    instantRun: '{n} negative comments since the last alert',
    instantWatched: 'Words to watch: {terms}',
    instantMore: 'And {n} more in SocialMonitor.',
    digestWeekSubject: '{brand}: last week in comments',
    digestMonthSubject: '{brand}: last month in comments',
    digestWeekHeading: 'Last week',
    digestMonthHeading: 'Last month',
    digestLead: 'What people said about {brand} in the last {days} days.',
    digestNew: 'New comments',
    digestComplaints: 'Complaints',
    digestQuestions: 'Questions',
    digestPraise: 'Praise',
    digestReply: 'Still need an answer',
    digestPdf: 'The full brand report is attached as a PDF.',
    open: 'Open SocialMonitor',
    orCopy: 'Or copy this link:',
    credit: 'SocialMonitor · Free and open source · Built by Shades Media Group',
  },
  ro: {
    codeSubject: '{code} este codul tău de conectare SocialMonitor',
    codeHeading: 'Codul tău de conectare',
    codeLabel: 'Cod de conectare',
    codeValid: 'Valabil 10 minute',
    codeStub: 'Dacă nu tocmai te-ai conectat, schimbă-ți parola: cineva o cunoaște.',
    resetCodeSubject: '{code} este codul tău SocialMonitor pentru parolă',
    resetCodeHeading: 'Codul tău pentru schimbarea parolei',
    resetCodeLabel: 'Cod pentru parolă',
    resetCodeStub:
      'Dacă nu ai cerut să-ți schimbi parola, ignoră acest email. Parola rămâne aceeași.',
    inviteSubject: '{from} te-a invitat în SocialMonitor',
    inviteHeading: 'Ești invitat',
    inviteLead: '{from} ți-a dat acces la SocialMonitor. Alege-ți parola ca să începi.',
    inviteButton: 'Alege-ți parola',
    inviteNote: 'Linkul funcționează o singură dată, timp de 72 de ore.',
    resetSubject: 'Setează o parolă nouă pentru SocialMonitor',
    resetHeading: 'Setează o parolă nouă',
    resetButton: 'Alege o parolă nouă',
    resetNote: 'Linkul funcționează o singură dată, timp de 30 de minute.',
    forgotNote:
      'Linkul funcționează o singură dată, timp de 30 de minute. Dacă nu l-ai cerut, ignoră acest e-mail.',
    accessSubject: 'Ai acces nou în SocialMonitor',
    accessHeading: 'Acces nou',
    accessLead: '{from} ți-a dat acces la {brands}. Conectează-te ca să vezi.',
    everyBrand: 'toate brandurile',
    badSubject: '{brand}: {n} comentarii negative',
    badHeading: '{n} comentarii negative',
    badLead: 'PDF-ul atașat cuprinde {n} comentarii negative despre {brand}, grupate pe tipuri.',
    instantSubject: '{brand}: {n} comentarii au nevoie de tine acum',
    instantHeading: '{n} comentarii au nevoie de tine acum',
    instantLead:
      'Ultima actualizare pentru {brand} le-a găsit. Fiecare comentariu se trimite o singură dată.',
    instantUrgent: 'Urgente',
    instantRun: '{n} comentarii negative de la ultima alertă',
    instantWatched: 'Cuvinte urmărite: {terms}',
    instantMore: 'Și încă {n} în SocialMonitor.',
    digestWeekSubject: '{brand}: comentariile săptămânii trecute',
    digestMonthSubject: '{brand}: comentariile lunii trecute',
    digestWeekHeading: 'Săptămâna trecută',
    digestMonthHeading: 'Luna trecută',
    digestLead: 'Ce au spus oamenii despre {brand} în ultimele {days} zile.',
    digestNew: 'Comentarii noi',
    digestComplaints: 'Plângeri',
    digestQuestions: 'Întrebări',
    digestPraise: 'Laude',
    digestReply: 'Încă așteaptă un răspuns',
    digestPdf: 'Raportul complet al brandului e atașat ca PDF.',
    open: 'Deschide SocialMonitor',
    orCopy: 'Sau copiază acest link:',
    credit: 'SocialMonitor · Gratuit și open source · Creat de Shades Media Group',
  },
  ru: {
    codeSubject: '{code} — ваш код для входа в SocialMonitor',
    codeHeading: 'Ваш код для входа',
    codeLabel: 'Код для входа',
    codeValid: 'Действует 10 минут',
    codeStub: 'Если вы сейчас не входили, смените пароль: его кто-то знает.',
    resetCodeSubject: '{code} — ваш код SocialMonitor для смены пароля',
    resetCodeHeading: 'Ваш код для смены пароля',
    resetCodeLabel: 'Код для пароля',
    resetCodeStub:
      'Если вы не просили сменить пароль, просто проигнорируйте это письмо. Пароль останется прежним.',
    inviteSubject: '{from} приглашает вас в SocialMonitor',
    inviteHeading: 'Вас пригласили',
    inviteLead: '{from} открыл(а) вам доступ к SocialMonitor. Придумайте пароль, чтобы начать.',
    inviteButton: 'Придумать пароль',
    inviteNote: 'Ссылка работает один раз в течение 72 часов.',
    resetSubject: 'Новый пароль для SocialMonitor',
    resetHeading: 'Новый пароль',
    resetButton: 'Придумать новый пароль',
    resetNote: 'Ссылка работает один раз в течение 30 минут.',
    forgotNote:
      'Ссылка работает один раз в течение 30 минут. Если вы её не запрашивали, просто проигнорируйте это письмо.',
    accessSubject: 'У вас новый доступ в SocialMonitor',
    accessHeading: 'Новый доступ',
    accessLead: '{from} открыл(а) вам доступ к: {brands}. Войдите, чтобы посмотреть.',
    everyBrand: 'все бренды',
    badSubject: '{brand}: негативных комментариев: {n}',
    badHeading: 'Негативных комментариев: {n}',
    badLead: 'В приложенном PDF {n} негативных комментариев о {brand}, сгруппированных по видам.',
    instantSubject: '{brand}: комментариев, которым нужно внимание: {n}',
    instantHeading: 'Комментариев, которым нужно внимание: {n}',
    instantLead: 'Их нашло последнее обновление {brand}. Каждый комментарий отправляется один раз.',
    instantUrgent: 'Срочные',
    instantRun: 'Негативных комментариев с прошлого оповещения: {n}',
    instantWatched: 'Отслеживаемые слова: {terms}',
    instantMore: 'И ещё {n} в SocialMonitor.',
    digestWeekSubject: '{brand}: комментарии за прошлую неделю',
    digestMonthSubject: '{brand}: комментарии за прошлый месяц',
    digestWeekHeading: 'Прошлая неделя',
    digestMonthHeading: 'Прошлый месяц',
    digestLead: 'Что люди говорили о {brand} за последние дни: {days}.',
    digestNew: 'Новые комментарии',
    digestComplaints: 'Жалобы',
    digestQuestions: 'Вопросы',
    digestPraise: 'Похвала',
    digestReply: 'Ещё ждут ответа',
    digestPdf: 'Полный отчёт по бренду приложен в PDF.',
    open: 'Открыть SocialMonitor',
    orCopy: 'Или скопируйте ссылку:',
    credit: 'SocialMonitor · Бесплатно и с открытым кодом · Создано Shades Media Group',
  },
  fr: {
    codeSubject: '{code} est votre code de connexion SocialMonitor',
    codeHeading: 'Votre code de connexion',
    codeLabel: 'Code de connexion',
    codeValid: 'Valable 10 minutes',
    codeStub:
      'Si vous ne venez pas de vous connecter, changez votre mot de passe : quelqu’un le connaît.',
    resetCodeSubject: '{code} est votre code SocialMonitor pour le mot de passe',
    resetCodeHeading: 'Votre code pour changer de mot de passe',
    resetCodeLabel: 'Code de mot de passe',
    resetCodeStub:
      'Si vous n’avez pas demandé à changer de mot de passe, ignorez cet e-mail. Votre mot de passe reste le même.',
    inviteSubject: '{from} vous invite sur SocialMonitor',
    inviteHeading: 'Vous êtes invité',
    inviteLead:
      '{from} vous a donné accès à SocialMonitor. Choisissez votre mot de passe pour commencer.',
    inviteButton: 'Choisir mon mot de passe',
    inviteNote: 'Le lien fonctionne une seule fois, pendant 72 heures.',
    resetSubject: 'Nouveau mot de passe SocialMonitor',
    resetHeading: 'Nouveau mot de passe',
    resetButton: 'Choisir un nouveau mot de passe',
    resetNote: 'Le lien fonctionne une seule fois, pendant 30 minutes.',
    forgotNote:
      'Le lien fonctionne une seule fois, pendant 30 minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail.',
    accessSubject: 'Nouvel accès sur SocialMonitor',
    accessHeading: 'Nouvel accès',
    accessLead: '{from} vous a donné accès à {brands}. Connectez-vous pour le voir.',
    everyBrand: 'toutes les marques',
    badSubject: '{brand} : {n} commentaires négatifs',
    badHeading: '{n} commentaires négatifs',
    badLead: 'Le PDF joint liste {n} commentaires négatifs sur {brand}, classés par type.',
    instantSubject: '{brand} : {n} commentaires ont besoin de vous',
    instantHeading: '{n} commentaires ont besoin de vous',
    instantLead:
      'La dernière mise à jour de {brand} les a trouvés. Chaque commentaire n’est envoyé qu’une fois.',
    instantUrgent: 'Urgents',
    instantRun: '{n} commentaires négatifs depuis la dernière alerte',
    instantWatched: 'Mots à suivre : {terms}',
    instantMore: 'Et {n} autres dans SocialMonitor.',
    digestWeekSubject: '{brand} : la semaine dernière en commentaires',
    digestMonthSubject: '{brand} : le mois dernier en commentaires',
    digestWeekHeading: 'La semaine dernière',
    digestMonthHeading: 'Le mois dernier',
    digestLead: 'Ce que les gens ont dit de {brand} ces {days} derniers jours.',
    digestNew: 'Nouveaux commentaires',
    digestComplaints: 'Plaintes',
    digestQuestions: 'Questions',
    digestPraise: 'Éloges',
    digestReply: 'Attendent encore une réponse',
    digestPdf: 'Le rapport complet de la marque est joint en PDF.',
    open: 'Ouvrir SocialMonitor',
    orCopy: 'Ou copiez ce lien :',
    credit: 'SocialMonitor · Gratuit et open source · Créé par Shades Media Group',
  },
  zh: {
    codeSubject: '{code} 是你的 SocialMonitor 登录验证码',
    codeHeading: '你的登录验证码',
    codeLabel: '登录验证码',
    codeValid: '10 分钟内有效',
    codeStub: '如果不是你本人在登录，请修改密码：有人知道了它。',
    resetCodeSubject: '{code} 是你的 SocialMonitor 密码验证码',
    resetCodeHeading: '你的修改密码验证码',
    resetCodeLabel: '密码验证码',
    resetCodeStub: '如果你没有申请修改密码，请忽略此邮件。你的密码不会改变。',
    inviteSubject: '{from} 邀请你使用 SocialMonitor',
    inviteHeading: '你收到了邀请',
    inviteLead: '{from} 已为你开通 SocialMonitor 的访问权限。设置密码即可开始。',
    inviteButton: '设置密码',
    inviteNote: '链接只能使用一次，72 小时内有效。',
    resetSubject: '设置新的 SocialMonitor 密码',
    resetHeading: '设置新密码',
    resetButton: '设置新密码',
    resetNote: '链接只能使用一次，30 分钟内有效。',
    forgotNote: '链接只能使用一次，30 分钟内有效。如果不是你申请的，请忽略这封邮件。',
    accessSubject: '你在 SocialMonitor 有了新的访问权限',
    accessHeading: '新的访问权限',
    accessLead: '{from} 已为你开通 {brands} 的访问权限。登录即可查看。',
    everyBrand: '所有品牌',
    badSubject: '{brand}：{n} 条负面评论',
    badHeading: '{n} 条负面评论',
    badLead: '附件 PDF 列出了关于 {brand} 的 {n} 条负面评论，按类型分组。',
    instantSubject: '{brand}：{n} 条评论需要你立即处理',
    instantHeading: '{n} 条评论需要你立即处理',
    instantLead: '这些评论由 {brand} 的最近一次更新发现。每条评论只发送一次。',
    instantUrgent: '紧急',
    instantRun: '自上次提醒以来的 {n} 条负面评论',
    instantWatched: '关注词：{terms}',
    instantMore: '另有 {n} 条，请在 SocialMonitor 中查看。',
    digestWeekSubject: '{brand}：上周评论回顾',
    digestMonthSubject: '{brand}：上月评论回顾',
    digestWeekHeading: '上周',
    digestMonthHeading: '上月',
    digestLead: '过去 {days} 天里人们对 {brand} 的评价。',
    digestNew: '新评论',
    digestComplaints: '投诉',
    digestQuestions: '提问',
    digestPraise: '好评',
    digestReply: '仍待回复',
    digestPdf: '完整的品牌报告已作为 PDF 附上。',
    open: '打开 SocialMonitor',
    orCopy: '或复制这个链接：',
    credit: 'SocialMonitor · 免费、开源 · 由 Shades Media Group 打造',
  },
}

export const mailLang = (x: unknown): MailLang =>
  x === 'ro' || x === 'ru' || x === 'fr' || x === 'zh' ? x : 'en'

export const mailText = (lang: string, key: Key, vars: Record<string, string> = {}) =>
  (TEXT[mailLang(lang)][key] ?? TEXT.en[key]).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')
