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
  | 'secWhen'
  | 'secWhere'
  | 'secDevice'
  | 'secMethod'
  | 'secBy'
  | 'secUnknown'
  | 'secNotYou'
  | 'secNotYouFailed'
  | 'secNotYouAdmin'
  | 'newDeviceSubject'
  | 'newDeviceHeading'
  | 'newDeviceLead'
  | 'passwordSubject'
  | 'passwordHeading'
  | 'passwordLead'
  | 'factorAddedSubject'
  | 'factorAddedHeading'
  | 'factorAddedLead'
  | 'factorRemovedSubject'
  | 'factorRemovedHeading'
  | 'factorRemovedLead'
  | 'failedSubject'
  | 'failedHeading'
  | 'failedLead'
  | 'newAdminSubject'
  | 'newAdminHeading'
  | 'newAdminLead'
  | 'newAdminOthersSubject'
  | 'newAdminOthersHeading'
  | 'newAdminOthersLead'
  | 'scopeSuper'
  | 'scopeBrand'

const TEXT: Record<MailLang, Record<Key, string>> = {
  en: {
    codeSubject: '{code} is your SocialMonitor sign-in code',
    codeHeading: 'Your sign-in code',
    codeLabel: 'Sign-in code',
    codeValid: 'Works for 10 minutes',
    codeStub: 'If you did not just sign in, change your password: someone knows it.',
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
    secWhen: 'When',
    secWhere: 'From where',
    secDevice: 'Device',
    secMethod: 'Method',
    secBy: 'Done by',
    secUnknown: 'Unknown',
    secNotYou:
      'If this wasn’t you, change your password now, then use Sign out everywhere in Settings and tell your super admin.',
    secNotYouFailed:
      'If this wasn’t you, someone may be guessing your password. Sign-ins to your account are paused for 15 minutes; change your password to a long one you use nowhere else.',
    secNotYouAdmin:
      'If you didn’t expect this, open Activity in SocialMonitor to see who did it, and take the access back in People.',
    newDeviceSubject: 'New sign-in to your SocialMonitor account',
    newDeviceHeading: 'New sign-in',
    newDeviceLead:
      'Your account was just signed in from a device or a country it has not used before.',
    passwordSubject: 'Your SocialMonitor password was changed',
    passwordHeading: 'Password changed',
    passwordLead:
      'The password of your account was changed, and every other session was signed out.',
    factorAddedSubject: 'A second factor was added to your SocialMonitor account',
    factorAddedHeading: 'Second factor added',
    factorAddedLead: 'A new way to confirm sign-ins was added to your account.',
    factorRemovedSubject: 'A second factor was removed from your SocialMonitor account',
    factorRemovedHeading: 'Second factor removed',
    factorRemovedLead: 'A way to confirm sign-ins was removed from your account.',
    failedSubject: 'Five failed sign-ins to your SocialMonitor account',
    failedHeading: 'Five failed sign-ins',
    failedLead:
      'Someone tried to sign in to your account five times in a row with a wrong password or code.',
    newAdminSubject: 'You are now an admin in SocialMonitor',
    newAdminHeading: 'You are now an admin',
    newAdminLead: '{by} made you {scope}.',
    newAdminOthersSubject: '{who} is now an admin in SocialMonitor',
    newAdminOthersHeading: 'New admin',
    newAdminOthersLead: '{by} made {who} {scope}.',
    scopeSuper: 'a super admin',
    scopeBrand: 'an admin of {brand}',
  },
  ro: {
    codeSubject: '{code} este codul tău de conectare SocialMonitor',
    codeHeading: 'Codul tău de conectare',
    codeLabel: 'Cod de conectare',
    codeValid: 'Valabil 10 minute',
    codeStub: 'Dacă nu tocmai te-ai conectat, schimbă-ți parola: cineva o cunoaște.',
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
    secWhen: 'Când',
    secWhere: 'De unde',
    secDevice: 'Dispozitiv',
    secMethod: 'Metodă',
    secBy: 'Făcut de',
    secUnknown: 'Necunoscut',
    secNotYou:
      'Dacă nu ai fost tu, schimbă-ți parola acum, apoi folosește Deconectare de peste tot din Setări și anunță-ți super adminul.',
    secNotYouFailed:
      'Dacă nu ai fost tu, cineva poate încearcă să-ți ghicească parola. Conectările la contul tău sunt oprite 15 minute; schimbă-ți parola cu una lungă, pe care n-o folosești în altă parte.',
    secNotYouAdmin:
      'Dacă nu te așteptai la asta, deschide Activitate în SocialMonitor ca să vezi cine a făcut-o și retrage accesul din Persoane.',
    newDeviceSubject: 'Conectare nouă la contul tău SocialMonitor',
    newDeviceHeading: 'Conectare nouă',
    newDeviceLead:
      'Contul tău tocmai a fost conectat de pe un dispozitiv sau dintr-o țară folosite pentru prima dată.',
    passwordSubject: 'Parola ta SocialMonitor a fost schimbată',
    passwordHeading: 'Parolă schimbată',
    passwordLead:
      'Parola contului tău a fost schimbată, iar toate celelalte sesiuni au fost deconectate.',
    factorAddedSubject: 'Un al doilea factor a fost adăugat contului tău SocialMonitor',
    factorAddedHeading: 'Al doilea factor adăugat',
    factorAddedLead: 'Contului tău i s-a adăugat o nouă metodă de confirmare a conectărilor.',
    factorRemovedSubject: 'Un al doilea factor a fost eliminat din contul tău SocialMonitor',
    factorRemovedHeading: 'Al doilea factor eliminat',
    factorRemovedLead: 'O metodă de confirmare a conectărilor a fost eliminată din contul tău.',
    failedSubject: 'Cinci conectări eșuate la contul tău SocialMonitor',
    failedHeading: 'Cinci conectări eșuate',
    failedLead:
      'Cineva a încercat de cinci ori la rând să se conecteze la contul tău cu o parolă sau un cod greșit.',
    newAdminSubject: 'Acum ești administrator în SocialMonitor',
    newAdminHeading: 'Acum ești administrator',
    newAdminLead: '{by} te-a făcut {scope}.',
    newAdminOthersSubject: '{who} este acum administrator în SocialMonitor',
    newAdminOthersHeading: 'Administrator nou',
    newAdminOthersLead: '{by} l-a făcut pe {who} {scope}.',
    scopeSuper: 'super admin',
    scopeBrand: 'administrator al brandului {brand}',
  },
  ru: {
    codeSubject: '{code} — ваш код для входа в SocialMonitor',
    codeHeading: 'Ваш код для входа',
    codeLabel: 'Код для входа',
    codeValid: 'Действует 10 минут',
    codeStub: 'Если вы сейчас не входили, смените пароль: его кто-то знает.',
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
    secWhen: 'Когда',
    secWhere: 'Откуда',
    secDevice: 'Устройство',
    secMethod: 'Способ',
    secBy: 'Кто сделал',
    secUnknown: 'Неизвестно',
    secNotYou:
      'Если это были не вы, сразу смените пароль, затем нажмите «Выйти на всех устройствах» в настройках и сообщите своему супер-администратору.',
    secNotYouFailed:
      'Если это были не вы, кто-то, возможно, подбирает ваш пароль. Вход в аккаунт приостановлен на 15 минут; смените пароль на длинный, который вы нигде больше не используете.',
    secNotYouAdmin:
      'Если вы этого не ожидали, откройте «Активность» в SocialMonitor, чтобы увидеть, кто это сделал, и отзовите доступ в разделе «Люди».',
    newDeviceSubject: 'Новый вход в ваш аккаунт SocialMonitor',
    newDeviceHeading: 'Новый вход',
    newDeviceLead:
      'В ваш аккаунт только что вошли с устройства или из страны, которые раньше не использовались.',
    passwordSubject: 'Пароль от SocialMonitor изменён',
    passwordHeading: 'Пароль изменён',
    passwordLead: 'Пароль вашего аккаунта изменён, все остальные сеансы завершены.',
    factorAddedSubject: 'К вашему аккаунту SocialMonitor добавлен второй фактор',
    factorAddedHeading: 'Второй фактор добавлен',
    factorAddedLead: 'К вашему аккаунту добавлен новый способ подтверждения входа.',
    factorRemovedSubject: 'Из вашего аккаунта SocialMonitor удалён второй фактор',
    factorRemovedHeading: 'Второй фактор удалён',
    factorRemovedLead: 'Из вашего аккаунта удалён способ подтверждения входа.',
    failedSubject: 'Пять неудачных попыток входа в ваш аккаунт SocialMonitor',
    failedHeading: 'Пять неудачных входов',
    failedLead: 'Кто-то пять раз подряд пытался войти в ваш аккаунт с неверным паролем или кодом.',
    newAdminSubject: 'Теперь вы администратор в SocialMonitor',
    newAdminHeading: 'Вы теперь администратор',
    newAdminLead: '{by} назначил(а) вас: {scope}.',
    newAdminOthersSubject: '{who} теперь администратор в SocialMonitor',
    newAdminOthersHeading: 'Новый администратор',
    newAdminOthersLead: '{by} назначил(а) {who}: {scope}.',
    scopeSuper: 'супер-администратор',
    scopeBrand: 'администратор бренда {brand}',
  },
  fr: {
    codeSubject: '{code} est votre code de connexion SocialMonitor',
    codeHeading: 'Votre code de connexion',
    codeLabel: 'Code de connexion',
    codeValid: 'Valable 10 minutes',
    codeStub:
      'Si vous ne venez pas de vous connecter, changez votre mot de passe : quelqu’un le connaît.',
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
    secWhen: 'Quand',
    secWhere: 'D’où',
    secDevice: 'Appareil',
    secMethod: 'Méthode',
    secBy: 'Fait par',
    secUnknown: 'Inconnu',
    secNotYou:
      'Si ce n’était pas vous, changez votre mot de passe maintenant, puis utilisez Se déconnecter partout dans les réglages et prévenez votre super admin.',
    secNotYouFailed:
      'Si ce n’était pas vous, quelqu’un essaie peut-être de deviner votre mot de passe. Les connexions à votre compte sont suspendues 15 minutes ; choisissez un mot de passe long que vous n’utilisez nulle part ailleurs.',
    secNotYouAdmin:
      'Si vous ne vous y attendiez pas, ouvrez Activité dans SocialMonitor pour voir qui l’a fait, et retirez l’accès dans Personnes.',
    newDeviceSubject: 'Nouvelle connexion à votre compte SocialMonitor',
    newDeviceHeading: 'Nouvelle connexion',
    newDeviceLead:
      'Votre compte vient d’être connecté depuis un appareil ou un pays jamais utilisé auparavant.',
    passwordSubject: 'Votre mot de passe SocialMonitor a été modifié',
    passwordHeading: 'Mot de passe modifié',
    passwordLead:
      'Le mot de passe de votre compte a été modifié et toutes les autres sessions ont été fermées.',
    factorAddedSubject: 'Un second facteur a été ajouté à votre compte SocialMonitor',
    factorAddedHeading: 'Second facteur ajouté',
    factorAddedLead: 'Une nouvelle façon de confirmer les connexions a été ajoutée à votre compte.',
    factorRemovedSubject: 'Un second facteur a été retiré de votre compte SocialMonitor',
    factorRemovedHeading: 'Second facteur retiré',
    factorRemovedLead: 'Une façon de confirmer les connexions a été retirée de votre compte.',
    failedSubject: 'Cinq échecs de connexion à votre compte SocialMonitor',
    failedHeading: 'Cinq échecs de connexion',
    failedLead:
      'Quelqu’un a essayé cinq fois de suite de se connecter à votre compte avec un mauvais mot de passe ou code.',
    newAdminSubject: 'Vous êtes maintenant administrateur dans SocialMonitor',
    newAdminHeading: 'Vous êtes administrateur',
    newAdminLead: '{by} vous a nommé {scope}.',
    newAdminOthersSubject: '{who} est maintenant administrateur dans SocialMonitor',
    newAdminOthersHeading: 'Nouvel administrateur',
    newAdminOthersLead: '{by} a nommé {who} {scope}.',
    scopeSuper: 'super admin',
    scopeBrand: 'administrateur de {brand}',
  },
  zh: {
    codeSubject: '{code} 是你的 SocialMonitor 登录验证码',
    codeHeading: '你的登录验证码',
    codeLabel: '登录验证码',
    codeValid: '10 分钟内有效',
    codeStub: '如果不是你本人在登录，请修改密码：有人知道了它。',
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
    secWhen: '时间',
    secWhere: '来源',
    secDevice: '设备',
    secMethod: '方式',
    secBy: '操作人',
    secUnknown: '未知',
    secNotYou:
      '如果不是你本人操作，请立即修改密码，然后在设置中使用“在所有设备上退出”，并告知你的超级管理员。',
    secNotYouFailed:
      '如果不是你本人，可能有人在猜你的密码。你的账号已暂停登录 15 分钟；请把密码改成一个较长且未在别处使用过的密码。',
    secNotYouAdmin:
      '如果这出乎你的意料，请在 SocialMonitor 中打开“活动记录”查看是谁操作的，并在“成员”中收回该权限。',
    newDeviceSubject: '你的 SocialMonitor 账号有新的登录',
    newDeviceHeading: '新的登录',
    newDeviceLead: '你的账号刚刚从一个以前未使用过的设备或国家/地区登录。',
    passwordSubject: '你的 SocialMonitor 密码已修改',
    passwordHeading: '密码已修改',
    passwordLead: '你账号的密码已修改，其他所有会话均已退出。',
    factorAddedSubject: '你的 SocialMonitor 账号添加了第二验证方式',
    factorAddedHeading: '已添加第二验证方式',
    factorAddedLead: '你的账号添加了一种新的登录确认方式。',
    factorRemovedSubject: '你的 SocialMonitor 账号移除了第二验证方式',
    factorRemovedHeading: '已移除第二验证方式',
    factorRemovedLead: '你的账号移除了一种登录确认方式。',
    failedSubject: '你的 SocialMonitor 账号连续五次登录失败',
    failedHeading: '五次登录失败',
    failedLead: '有人连续五次使用错误的密码或验证码尝试登录你的账号。',
    newAdminSubject: '你现在是 SocialMonitor 的管理员',
    newAdminHeading: '你现在是管理员',
    newAdminLead: '{by} 已将你设为{scope}。',
    newAdminOthersSubject: '{who} 现在是 SocialMonitor 的管理员',
    newAdminOthersHeading: '新管理员',
    newAdminOthersLead: '{by} 已将 {who} 设为{scope}。',
    scopeSuper: '超级管理员',
    scopeBrand: '{brand} 的管理员',
  },
}

export const mailLang = (x: unknown): MailLang =>
  x === 'ro' || x === 'ru' || x === 'fr' || x === 'zh' ? x : 'en'

export const mailText = (lang: string, key: Key, vars: Record<string, string> = {}) =>
  (TEXT[mailLang(lang)][key] ?? TEXT.en[key]).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')
