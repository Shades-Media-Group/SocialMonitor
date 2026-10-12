/**
 * The emails SocialMonitor sends, in each dashboard language. {placeholders} are filled in by
 * mailText. Keep every language's set complete: a missing key falls back to English.
 */
export type MailLang = 'en' | 'ro' | 'ru' | 'fr' | 'zh'
type Key =
  | 'codeSubject'
  | 'codeBody'
  | 'inviteSubject'
  | 'inviteBody'
  | 'resetSubject'
  | 'resetBody'
  | 'forgotBody'
  | 'accessSubject'
  | 'accessBody'
  | 'everyBrand'
  | 'badSubject'
  | 'badBody'
  | 'credit'

const TEXT: Record<MailLang, Record<Key, string>> = {
  en: {
    codeSubject: 'Your SocialMonitor code: {code}',
    codeBody:
      'Your sign-in code is {code}. It works for 10 minutes.\n\nIf you did not just sign in, change your password: someone knows it.',
    inviteSubject: '{from} invited you to SocialMonitor',
    inviteBody:
      '{from} gave you access to SocialMonitor.\n\nChoose your password here:\n{link}\n\nThe link works once, for 72 hours.',
    resetSubject: 'Set a new SocialMonitor password',
    resetBody: 'Choose a new password here:\n{link}\n\nThe link works once, for 30 minutes.',
    forgotBody:
      'Choose a new password here:\n{link}\n\nThe link works once, for 30 minutes. If you did not ask for it, ignore this email.',
    accessSubject: 'You have new access in SocialMonitor',
    accessBody: '{from} gave you access to {brands}. Sign in to see it.',
    everyBrand: 'every brand',
    badSubject: '{brand}: {n} negative comments',
    badBody:
      'The attached PDF lists {n} negative comments about {brand}, grouped by kind.\n\nOpen SocialMonitor to answer them.',
    credit: 'SocialMonitor. Free and open source. Built by Shades Media Group.',
  },
  ro: {
    codeSubject: 'Codul tău SocialMonitor: {code}',
    codeBody:
      'Codul tău de conectare este {code}. Este valabil 10 minute.\n\nDacă nu tocmai te-ai conectat, schimbă-ți parola: cineva o cunoaște.',
    inviteSubject: '{from} te-a invitat în SocialMonitor',
    inviteBody:
      '{from} ți-a dat acces la SocialMonitor.\n\nAlege-ți parola aici:\n{link}\n\nLinkul funcționează o singură dată, timp de 72 de ore.',
    resetSubject: 'Setează o parolă nouă pentru SocialMonitor',
    resetBody:
      'Alege o parolă nouă aici:\n{link}\n\nLinkul funcționează o singură dată, timp de 30 de minute.',
    forgotBody:
      'Alege o parolă nouă aici:\n{link}\n\nLinkul funcționează o singură dată, timp de 30 de minute. Dacă nu l-ai cerut, ignoră acest e-mail.',
    accessSubject: 'Ai acces nou în SocialMonitor',
    accessBody: '{from} ți-a dat acces la {brands}. Conectează-te ca să vezi.',
    everyBrand: 'toate brandurile',
    badSubject: '{brand}: {n} comentarii negative',
    badBody:
      'PDF-ul atașat cuprinde {n} comentarii negative despre {brand}, grupate pe tipuri.\n\nDeschide SocialMonitor ca să le răspunzi.',
    credit: 'SocialMonitor. Gratuit și open source. Creat de Shades Media Group.',
  },
  ru: {
    codeSubject: 'Ваш код SocialMonitor: {code}',
    codeBody:
      'Ваш код для входа: {code}. Он действует 10 минут.\n\nЕсли вы сейчас не входили, смените пароль: его кто-то знает.',
    inviteSubject: '{from} приглашает вас в SocialMonitor',
    inviteBody:
      '{from} открыл(а) вам доступ к SocialMonitor.\n\nПридумайте пароль здесь:\n{link}\n\nСсылка работает один раз в течение 72 часов.',
    resetSubject: 'Новый пароль для SocialMonitor',
    resetBody:
      'Придумайте новый пароль здесь:\n{link}\n\nСсылка работает один раз в течение 30 минут.',
    forgotBody:
      'Придумайте новый пароль здесь:\n{link}\n\nСсылка работает один раз в течение 30 минут. Если вы её не запрашивали, просто проигнорируйте это письмо.',
    accessSubject: 'У вас новый доступ в SocialMonitor',
    accessBody: '{from} открыл(а) вам доступ к: {brands}. Войдите, чтобы посмотреть.',
    everyBrand: 'все бренды',
    badSubject: '{brand}: негативных комментариев: {n}',
    badBody:
      'В приложенном PDF {n} негативных комментариев о {brand}, сгруппированных по видам.\n\nОткройте SocialMonitor, чтобы ответить.',
    credit: 'SocialMonitor. Бесплатно и с открытым кодом. Создано Shades Media Group.',
  },
  fr: {
    codeSubject: 'Votre code SocialMonitor : {code}',
    codeBody:
      'Votre code de connexion est {code}. Il est valable 10 minutes.\n\nSi vous ne venez pas de vous connecter, changez votre mot de passe : quelqu’un le connaît.',
    inviteSubject: '{from} vous invite sur SocialMonitor',
    inviteBody:
      '{from} vous a donné accès à SocialMonitor.\n\nChoisissez votre mot de passe ici :\n{link}\n\nLe lien fonctionne une seule fois, pendant 72 heures.',
    resetSubject: 'Nouveau mot de passe SocialMonitor',
    resetBody:
      'Choisissez un nouveau mot de passe ici :\n{link}\n\nLe lien fonctionne une seule fois, pendant 30 minutes.',
    forgotBody:
      'Choisissez un nouveau mot de passe ici :\n{link}\n\nLe lien fonctionne une seule fois, pendant 30 minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail.',
    accessSubject: 'Nouvel accès sur SocialMonitor',
    accessBody: '{from} vous a donné accès à {brands}. Connectez-vous pour le voir.',
    everyBrand: 'toutes les marques',
    badSubject: '{brand} : {n} commentaires négatifs',
    badBody:
      'Le PDF joint liste {n} commentaires négatifs sur {brand}, classés par type.\n\nOuvrez SocialMonitor pour y répondre.',
    credit: 'SocialMonitor. Gratuit et open source. Créé par Shades Media Group.',
  },
  zh: {
    codeSubject: '你的 SocialMonitor 验证码：{code}',
    codeBody:
      '你的登录验证码是 {code}，10 分钟内有效。\n\n如果不是你本人在登录，请修改密码：有人知道了它。',
    inviteSubject: '{from} 邀请你使用 SocialMonitor',
    inviteBody:
      '{from} 已为你开通 SocialMonitor 的访问权限。\n\n在这里设置密码：\n{link}\n\n链接只能使用一次，72 小时内有效。',
    resetSubject: '设置新的 SocialMonitor 密码',
    resetBody: '在这里设置新密码：\n{link}\n\n链接只能使用一次，30 分钟内有效。',
    forgotBody:
      '在这里设置新密码：\n{link}\n\n链接只能使用一次，30 分钟内有效。如果不是你申请的，请忽略这封邮件。',
    accessSubject: '你在 SocialMonitor 有了新的访问权限',
    accessBody: '{from} 已为你开通 {brands} 的访问权限。登录即可查看。',
    everyBrand: '所有品牌',
    badSubject: '{brand}：{n} 条负面评论',
    badBody:
      '附件 PDF 列出了关于 {brand} 的 {n} 条负面评论，按类型分组。\n\n打开 SocialMonitor 回复它们。',
    credit: 'SocialMonitor。免费、开源。由 Shades Media Group 打造。',
  },
}

export const mailLang = (x: unknown): MailLang =>
  x === 'ro' || x === 'ru' || x === 'fr' || x === 'zh' ? x : 'en'

export const mailText = (lang: string, key: Key, vars: Record<string, string> = {}) =>
  (TEXT[mailLang(lang)][key] ?? TEXT.en[key]).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')
