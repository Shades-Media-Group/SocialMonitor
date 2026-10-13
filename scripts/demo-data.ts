/**
 * Demo data for the website's screenshots: a fictional food-delivery app, "Tavelo", with a
 * month of posts, comments, updates, reports and schedules. Everything goes into data/demo
 * (git-ignored), never into the real database. The folder is wiped and rebuilt on every run;
 * the content is fixed and dates are counted back from now.
 *
 * It writes through the app's own store, report and auth functions, so the shapes match what
 * a real update produces. No network calls and no AI: the labels, reasons and post
 * descriptions below are written by hand in the style the AI step writes them.
 *
 * Usage: node scripts/demo-data.ts   (Node 22.18+), then node scripts/demo-shots.ts
 * Sign-in details for the demo account land in data/demo/CREDENTIALS.txt.
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Profile, RunScope } from '../apps/app/src/core/types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(root, 'data', 'demo')
// The app reads SOCIALMONITOR_DATA when its modules load, so it is set before importing them.
process.env.SOCIALMONITOR_DATA = DEMO
const PHOTOS = resolve(root, '../gradient/apps/site/public/photos')

// --- The brand ---------------------------------------------------------------------------

const BRAND = 'Tavelo'
const HANDLE = 'tavelo'
/** Positive keys of the app's built-in "general" categories. */
const POSITIVE = new Set(['thanks', 'interest', 'other-positive'])

type Net = 'instagram' | 'facebook' | 'tiktok'
type L = 'P' | 'Q' | 'C' | 'S' | 'N' | 'X'
interface Opt {
  /** Needs a reply: defaults to 1 for complaints and questions. */
  r?: 0 | 1
  u?: 0 | 1 | 2
  e?: string
  cat?: string
  /** A key other comments on the same post can reply to. */
  k?: string
  to?: string
  likes?: number
  /** 'u': a person marked it answered; 'i': skipped. Left out: open, unless the brand replied. */
  st?: 'u' | 'i'
  /** The brand's reply under it, and how many hours later. */
  re?: string
  rh?: number
}
type C = [h: number, author: string, text: string, label: L, reason: string, opt?: Opt]
interface PostIn {
  net: Net
  d: number
  at: string
  kind: string
  img?: string
  caption: string
  description: string
  likes: number
  shares: number | null
  views: number | null
  /** Comments the network counts beyond those kept. */
  extra?: number
  cs: C[]
  /** The brand's own top-level comments: [hours, text]. */
  own?: [number, string][]
  /**
   * How its numbers moved after it went out. Default: most of it in the first 48 hours, then
   * flat. 'wave': picked up again this week and still growing. 'climb': comments keep coming.
   */
  grow?: 'wave' | 'climb'
}

// The eight newest posts each use a different photo, so the Posts grid never repeats one side
// by side; older posts reuse them or have none.
const POSTS: PostIn[] = [
  // Instagram
  {
    net: 'instagram',
    d: 28,
    at: '12:30',
    kind: 'photo',
    img: 'studio',
    caption:
      'New here? 40% off your first three orders with code HELLO40. Lunch at your desk, from the places you already love. Link in bio. #Tavelo',
    description:
      "A welcome offer: 40% off a new customer's first three orders with the code HELLO40, shown with lunch at a home desk.",
    likes: 642,
    shares: null,
    views: null,
    extra: 2,
    cs: [
      [
        1,
        'lina.writes',
        'Finally! Do you deliver to Westbrook yet?',
        'Q',
        'Asks if delivery reaches her area',
        {
          cat: 'interest',
          re: "Hi Lina! Westbrook goes live in November. Pop your address in at tavelo.example/areas and we'll email you the day it opens.",
        },
      ],
      [
        2,
        'markus.b',
        'Used the code last week, food came in 18 minutes. No complaints 👌',
        'P',
        'Happy with a fast first delivery',
        { likes: 14 },
      ],
      [
        3,
        'tomasz.k',
        'does the code work on grocery orders too or only restaurants?',
        'Q',
        'Asks if the code covers groceries',
        { re: 'Hi Tomasz, it works on both, as long as the order is over €10.' },
      ],
      [
        5,
        'ellie.t',
        'Rider was 40 min late and nobody told me. Food was great tho',
        'C',
        'Rider came late without an update',
        {
          cat: 'delivery',
          e: 'frustrated',
          re: "Sorry Ellie, that's not the evening we promised. Could you DM us your order number? We'd like to refund the delivery fee.",
        },
      ],
      [
        7,
        'priya.nair_',
        '@sam.ortiz this is the one I told you about',
        'N',
        'Tags a friend about the offer',
        { cat: 'interest' },
      ],
      [
        9,
        'win.big.daily',
        '🔥 Earn €500 a day from home, DM me to learn how 🔥',
        'X',
        'Money scheme unrelated to the post',
      ],
      [
        20,
        'joon.p',
        'Can I use it if I had an account years ago?',
        'Q',
        'Asks if an old account qualifies',
        { st: 'u' },
      ],
    ],
  },
  {
    net: 'instagram',
    d: 24,
    at: '18:00',
    kind: 'photo',
    img: 'dusk',
    caption: 'Something faster is coming to your doorstep. Watch this space. #Tavelo',
    description:
      'A teaser for a new Tavelo feature: a man checks his phone on a city street at dusk, with a hint of faster deliveries.',
    likes: 1180,
    shares: null,
    views: null,
    cs: [
      [
        1,
        'dani_moves',
        'faster than now?? took you long enough 😅',
        'N',
        'Teasing remark about the wait',
        { e: 'excited' },
      ],
      [
        2,
        'sofia_ve',
        'Will it cost extra or is it for everyone?',
        'Q',
        'Asks whether the feature costs extra',
        {
          cat: 'interest',
          re: "Hi Sofia! It's for everyone, no extra charge. More on Thursday 👀",
        },
      ],
      [
        4,
        'k.okafor',
        'Hope it stops riders getting lost in my building, they always call me from the wrong entrance',
        'C',
        'Riders keep going to the wrong entrance',
        {
          cat: 'delivery',
          e: 'disappointed',
          u: 0,
          re: 'That is one of the things it helps with. Add the right entrance to your address notes and riders will see it on the map.',
        },
      ],
      [
        6,
        'rafa_gomez',
        "Let's goooo",
        'P',
        'Excited about the coming feature',
        { e: 'excited', cat: 'other-positive' },
      ],
      [11, 'mei.lin', 'which cities first?', 'Q', 'Asks which cities get it first', { st: 'u' }],
    ],
  },
  {
    net: 'instagram',
    d: 19,
    at: '10:00',
    kind: 'reel',
    img: 'window',
    caption:
      'Live tracking is here, and so is our On-time promise: if your order arrives later than the time we show, the delivery is free. Every order, every city. #TaveloOnTime',
    description:
      'Tavelo launches live rider tracking and an On-time promise: deliveries that arrive later than the time shown are free.',
    likes: 2310,
    shares: null,
    views: 58400,
    extra: 6,
    cs: [
      [
        0.5,
        'oliver.hart',
        'Just watched my rider on the map the whole way, arrived 2 min early!! 🛵',
        'P',
        'Enjoys live tracking, early delivery',
        { e: 'excited', likes: 48 },
      ],
      [
        1,
        'ana.reyes_',
        'Does the promise work in Riverside too? 😕',
        'Q',
        'Asks if the promise covers Riverside',
        { e: 'disappointed', re: 'Hi Ana! Yes, every city we deliver to, Riverside included.' },
      ],
      [
        1.5,
        'bjorn.e',
        'Do I need to update the app for tracking?',
        'Q',
        'Asks if an app update is needed',
        { re: "Hi Bjørn, yes, version 8.4 or newer. It's in the store now." },
      ],
      [
        2,
        'tess.m',
        'Map says my rider is outside but nobody is here??',
        'C',
        'Map shows the rider, nobody at the door',
        {
          k: 'tess',
          cat: 'product',
          e: 'confused',
          re: "Hi Tess, sorry! Could you DM us your order number? The map can lag near tall buildings, we'll call the rider for you.",
        },
      ],
      [
        2.6,
        'chris.dl',
        'same here, he came 3 min later. the map jumps a bit',
        'N',
        'Shares his experience with another customer',
        { to: 'tess' },
      ],
      [2.5, 'yusuf.dmr', 'süper, finally 🙌', 'P', 'Pleased with the new tracking'],
      [
        3,
        'carla.bnt',
        'Does it count if the restaurant is slow, not the rider?',
        'Q',
        'Asks if restaurant delays count',
        { re: 'Yes Carla, the promise counts from the time we show you, whoever is late.' },
      ],
      [
        4,
        'gabe.lowe',
        "Been ordering with Tavelo for 5 years, this is the best thing you've done in a while",
        'P',
        'Long-time customer praises the launch',
        { likes: 31, e: 'grateful' },
      ],
      [
        5,
        'nightowl.sam',
        'tracking drains my battery so fast tho',
        'C',
        'Tracking drains phone battery',
        { cat: 'product', u: 0, st: 'u' },
      ],
      [
        6,
        'lena_kz',
        "Please add more restaurants in Hollowmere, we're always forgotten",
        'S',
        'Asks for more restaurants in Hollowmere',
        {
          r: 1,
          e: 'disappointed',
          re: "Hi Lena, Hollowmere isn't forgotten, promise! Twelve new places join there in December.",
        },
      ],
      [
        7,
        'free.followers.now',
        'Get 10k followers in 24h ➡️ link in bio',
        'X',
        'Follower-selling spam',
      ],
      [
        8,
        'marco.v',
        'ordered on the tram and it was at my door when I got home 👏',
        'P',
        'Praises well-timed delivery',
      ],
      [
        10,
        'isla.r',
        "how do I claim the free delivery if it's late",
        'Q',
        'Asks how to claim a late delivery',
        {
          cat: 'interest',
          re: "Hi Isla, nothing to claim: if it's late, the fee goes back to your card automatically.",
        },
      ],
      [
        12,
        'dev.amit',
        'Our office in the Northgate business park still shows 55 min every lunch, 300 of us order from you',
        'C',
        'Long delivery times to a business park',
        {
          cat: 'delivery',
          e: 'disappointed',
          re: "Thanks Amit, we've passed Northgate to our business team. Expect a message about group lunch delivery this week.",
        },
      ],
      [
        14,
        'rosa.lim',
        'Will it work for grocery orders too?',
        'Q',
        'Asks if groceries get tracking',
        { st: 'u' },
      ],
      [
        20,
        'hana.k',
        'the ad music is so good, what song is it',
        'Q',
        'Asks about the music in the video',
        { r: 0 },
      ],
      [
        26,
        'pete_f',
        'Northside still says 50 minutes. Paying the same fee as people in the centre who get it in 20',
        'C',
        'Pays the same fee for slower delivery',
        { cat: 'price', st: 'u' },
      ],
    ],
  },
  {
    net: 'instagram',
    d: 15,
    at: '11:00',
    kind: 'photo',
    img: 'balloons',
    caption:
      'Our first Tavelo Kitchen pop-up opens Saturday on Market Square 🎈 Free tastings from eight local restaurants, coffee on us, and the first 100 visitors get a tote bag. See you there!',
    description:
      "An invitation to Tavelo's first Kitchen pop-up on Market Square on Saturday, with free tastings from local restaurants and gifts.",
    likes: 890,
    shares: null,
    views: null,
    cs: [
      [
        1,
        'maya.flor',
        'Coming with my mum, she wants to try the dumpling place!',
        'P',
        'Plans to visit the pop-up',
        { cat: 'interest', e: 'excited' },
      ],
      [
        3,
        'theo.w',
        'What are the opening hours?',
        'Q',
        'Asks the pop-up opening hours',
        { re: 'Hi Theo! 11:00 to 20:00 on Saturday and Sunday.' },
      ],
      [
        4,
        'noor.a',
        'Is there parking nearby?',
        'Q',
        'Asks about parking near the pop-up',
        { st: 'u' },
      ],
      [
        6,
        'ines.c',
        'Love the stall design, saw it being built yesterday 😍',
        'P',
        'Likes the pop-up design',
      ],
      [
        9,
        'jules_b',
        'Could you do one on the east side too? Market Square is far for us',
        'S',
        'Asks for a pop-up on the east side',
      ],
      [
        30,
        'kris.travels',
        "The queue was huge but the staff were so patient. Best bao I've had all year",
        'P',
        'Praises patient staff and the food',
        { likes: 22, e: 'grateful' },
      ],
    ],
  },
  {
    net: 'instagram',
    d: 10,
    at: '13:00',
    kind: 'photo',
    img: 'hands',
    caption:
      "Split the bill in 3 taps: 1. Open your order 2. Tap 'Split' 3. Send the link. Everyone pays their share, nobody does maths. Swipe for the screens ➡️",
    description: "A three-step guide to splitting a group order's bill in the Tavelo app.",
    likes: 512,
    shares: null,
    views: null,
    cs: [
      [
        1,
        'clara.jm',
        'Does this work with Apple Pay?',
        'Q',
        'Asks if bill splitting takes Apple Pay',
        { re: 'Hi Clara, yes, every payment method in the app works for split bills.' },
      ],
      [
        2,
        'aiden_r',
        'Used it for our team lunch today, took 2 minutes. Love this',
        'P',
        'Split a team bill quickly',
      ],
      [
        3,
        'olga.s',
        "Stuck at step 3, the link says 'expired' every time",
        'C',
        'Split link keeps expiring',
        {
          k: 'olga',
          cat: 'product',
          e: 'frustrated',
          re: "Sorry Olga! Please update the app to version 8.5, that fixes the expired link. Still stuck? DM us and we'll split it for you.",
          rh: 0.8,
        },
      ],
      [5, 'ben.t', 'Can I split it unevenly?', 'Q', 'Asks about uneven splits', { st: 'u' }],
      [
        7,
        'olga.s',
        'Updated and it worked, thanks!',
        'P',
        'Fix worked after updating the app',
        { to: 'olga', e: 'grateful' },
      ],
      [9, 'lucas.mtn', 'you should add a video of this', 'S', 'Suggests a video tutorial'],
      [
        28,
        'vee.daily',
        'I split it and got charged for the whole order?!',
        'C',
        'Charged the full amount after splitting',
        {
          cat: 'price',
          e: 'worried',
          re: "Hi! The full amount is held for a few minutes, then released when the others pay. DM us if it's still there and we'll check.",
        },
      ],
    ],
  },
  {
    net: 'instagram',
    d: 6,
    at: '19:00',
    kind: 'photo',
    img: 'studio',
    caption:
      'Tavelo Pass is here 🍂 Free delivery on every order over €15 and 10% back on groceries, for €4.99/month. First month free, until 31 October.',
    description:
      'Tavelo launches Tavelo Pass: free delivery on orders over €15 and 10% back on groceries for €4.99 a month, first month free.',
    likes: 1460,
    shares: null,
    views: null,
    extra: 3,
    cs: [
      [
        0.5,
        'sara.bel',
        'Can existing customers get the free month or is it only for new ones?',
        'Q',
        'Asks if existing customers get the free month',
        {
          likes: 41,
          cat: 'interest',
          re: 'Hi Sara! Everyone gets the first month free, new and existing customers.',
        },
      ],
      [
        1,
        'jakob.h',
        'I paid delivery fees on 20 orders this year. Why do new people always get the better deal',
        'C',
        'Regular customer feels left out',
        {
          k: 'jakob',
          cat: 'price',
          likes: 63,
          re: 'Hi Jakob, the free month is for you too: tap Pass in the app, nothing to pay until it ends.',
        },
      ],
      [
        1.5,
        'amira.z',
        'Is the €15 before or after the discount?',
        'Q',
        'Asks how the minimum is counted',
        { re: 'Before discounts, Amira, so codes still work.' },
      ],
      [
        3,
        'jakob.h',
        'ok just joined in the app, that was easy. thanks',
        'P',
        'Joined after the reply',
        { to: 'jakob', e: 'grateful' },
      ],
      [
        2,
        'leo.marsh',
        'Does it work for orders from the pop-up?',
        'Q',
        'Asks if Pass covers the pop-up',
        { cat: 'interest' },
      ],
      [3, 'nat.ph', 'Best deal around honestly', 'P', 'Says the deal is the best'],
      [
        4,
        'fitz.g',
        'Is there a family version? We have 4 accounts',
        'Q',
        'Asks for a family Pass',
        { cat: 'interest' },
      ],
      [5, 'wren.a', '🍂🍂🍂', 'N', 'Emoji reaction only'],
      [
        6,
        'danny.kp',
        'Joined yesterday, still being charged delivery 24h later',
        'C',
        'Pass not applied after a day',
        { cat: 'service' },
      ],
      [7, 'cheap.phones.store', 'iPhone 16 Pro €199 only today 👉 DM', 'X', 'Fake phone sale spam'],
      [
        9,
        'hugo.r',
        "what's the catch? free delivery for 4.99 sounds too good",
        'Q',
        'Doubts the offer, asks about limits',
        {
          e: 'confused',
          re: 'Fair question, Hugo! No catch: free delivery on every order over €15, as often as you like. Under €15 the usual fee applies.',
        },
      ],
      [12, 'mila.ro', 'Joined, already saved €9 this week 👍', 'P', 'Happy after joining Pass'],
    ],
  },
  {
    net: 'instagram',
    d: 3,
    at: '12:00',
    kind: 'photo',
    img: 'wall-green',
    caption:
      "Meet Samuel, who has made 4,000 deliveries with us. His tip: add your door code and floor to your address, and your food gets to you while it's still hot 🔥",
    description:
      'A profile of Samuel, a Tavelo rider with 4,000 deliveries, with a tip about adding door codes for faster deliveries.',
    likes: 734,
    shares: null,
    views: null,
    cs: [
      [
        1,
        'grace.ow',
        'Samuel delivered to me last week, such a kind guy!',
        'P',
        'Praises a rider by name',
        { likes: 18, e: 'grateful' },
      ],
      [
        2,
        'hamza.y',
        'Do riders get the whole tip?',
        'Q',
        'Asks if riders keep all tips',
        { re: 'Yes Hamza, every cent of the tip goes to the rider.' },
      ],
      [
        4,
        'lou.writes',
        'Love seeing the people behind the app',
        'P',
        'Likes seeing riders on the account',
      ],
      [
        8,
        'erik.s',
        "How do I add the door code? Can't find it",
        'Q',
        'Cannot find where to add a door code',
      ],
      [
        22,
        'tina.ml',
        'added my floor and door code, thanks for the tip 🙏',
        'P',
        'Followed the tip',
        { cat: 'other-positive' },
      ],
    ],
  },
  {
    net: 'instagram',
    d: 1,
    at: '17:30',
    kind: 'photo',
    img: 'umbrella',
    caption: 'Rainy evening? Stay in. Free delivery on soups, ramen and pho until 22:00 🌧️🍜',
    description: 'A rainy-evening offer: free delivery on soups, ramen and pho until 22:00.',
    likes: 388,
    shares: null,
    views: null,
    cs: [
      [
        1,
        'ivy.chen',
        'Does it include the Thai place on Elm Street?',
        'Q',
        'Asks if a restaurant is included',
        { k: 'ivy', cat: 'interest' },
      ],
      [
        2,
        'mehmet.a',
        'it did for me, just ordered the khao soi',
        'N',
        'Answers another customer from experience',
        { to: 'ivy' },
      ],
      [
        3,
        'paolo.r',
        'Got charged €18 for a ramen that never came, is that not refunded??',
        'C',
        'Charged €18 for an order that never came',
        { cat: 'price', u: 2, e: 'angry', likes: 9 },
      ],
      [
        4,
        'ruby.k',
        "Perfect timing, it's pouring here",
        'P',
        'Plans to order with the offer',
        { cat: 'interest', e: 'excited' },
      ],
      [
        6,
        'noemi.d',
        'you should add hot chocolate to the list',
        'S',
        'Asks to add hot drinks to the offer',
      ],
    ],
  },

  // Facebook
  {
    net: 'facebook',
    d: 27,
    at: '15:00',
    kind: 'post',
    caption:
      'Planned maintenance: on Wednesday night between 02:00 and 04:00, the Tavelo app and website may be slow or briefly unavailable while we upgrade our systems for live tracking. Orders placed before 02:00 will still be delivered. Thank you for your patience.',
    description:
      'A notice of overnight app maintenance to prepare for live tracking, with the app possibly unavailable from 02:00 to 04:00.',
    likes: 86,
    shares: 14,
    views: null,
    cs: [
      [
        2,
        'Gary W.',
        'Thanks for the heads up 👍',
        'P',
        'Thanks the brand for the notice',
        { e: 'grateful' },
      ],
      [
        3,
        'Monica T.',
        'I work night shifts and order dinner at 3am. Can you give a discount?',
        'C',
        'Night worker cannot order, asks a discount',
        {
          cat: 'service',
          e: 'worried',
          re: "Hi Monica, sorry for the trouble. Message us after Wednesday and we'll add €5 credit to your account.",
        },
      ],
      [
        5,
        'Steve R.',
        "Every month there's maintenance, when is it going to be finished",
        'C',
        'Tired of repeated maintenance',
        { cat: 'product', u: 0, st: 'u' },
      ],
      [
        6,
        'Joanna L.',
        'Will scheduled orders still go through?',
        'Q',
        'Asks about scheduled orders',
        { re: "Hi Joanna, yes, scheduled orders aren't affected." },
      ],
      [8, 'Paul H.', 'good to get notice for once', 'P', 'Appreciates advance notice'],
      [
        20,
        'Agnes F.',
        'Does this affect grocery orders too?',
        'Q',
        'Asks if groceries are affected',
        { st: 'u' },
      ],
    ],
  },
  {
    net: 'facebook',
    d: 22,
    at: '12:00',
    kind: 'post',
    img: 'studio',
    caption:
      'Office Lunch 💼 One order for the whole team, one delivery, one invoice. 20% off your first team order: tavelo.example/office',
    description:
      'A Facebook post for Office Lunch: team orders with one delivery and one invoice, and 20% off the first order.',
    likes: 214,
    shares: 31,
    views: null,
    cs: [
      [
        1,
        'Harold B.',
        'Can we pay by invoice at the end of the month?',
        'Q',
        'Asks about monthly invoicing',
        { re: 'Hi Harold, yes, monthly invoicing is on for teams of 10 or more.' },
      ],
      [
        2,
        'Kateryna M.',
        'Our team order came 50 minutes late and half of it was missing. Order 4471-209',
        'C',
        'Late team order with missing dishes',
        {
          cat: 'delivery',
          e: 'angry',
          likes: 12,
          re: "Kateryna, that's not good enough, sorry. We've refunded the missing dishes and someone from our team will call you tomorrow.",
        },
      ],
      [
        4,
        'Dean P.',
        'Is there a minimum team size?',
        'Q',
        'Asks about the minimum team size',
        { cat: 'interest', re: 'Hi Dean, from 5 people.' },
      ],
      [
        5,
        'Rita S.',
        'Used it for 2 years, never missed a lunch',
        'P',
        'Praises reliable team lunches',
      ],
      [
        7,
        'Victor N.',
        'Can we set a budget per person?',
        'Q',
        'Asks about per-person budgets',
        { st: 'u' },
      ],
      [
        9,
        'Olu A.',
        'Food is good but your support chat had me waiting for 40 minutes',
        'C',
        'Forty minutes waiting for support',
        { cat: 'service', u: 0, st: 'u' },
      ],
      [
        23,
        'Brenda K.',
        'Shared with our office manager 👍',
        'P',
        'Shared the offer with a colleague',
      ],
      [
        30,
        'Lukas F.',
        'please add a vegetarian filter for team orders',
        'S',
        'Wants a vegetarian filter for teams',
      ],
    ],
  },
  {
    net: 'facebook',
    d: 18,
    at: '10:30',
    kind: 'post',
    img: 'dusk',
    caption:
      'Live tracking and the On-time promise are here! If your order is later than the time we show, the delivery is free. Every order, every city 👉 tavelo.example/ontime',
    description:
      'Tavelo announces live tracking and the On-time promise on Facebook: late deliveries are free in every city.',
    likes: 412,
    shares: 57,
    views: null,
    cs: [
      [
        1,
        'Martin E.',
        'Order was 15 min late and I was still charged delivery',
        'C',
        'Charged delivery on a late order',
        {
          cat: 'price',
          e: 'confused',
          re: "Hi Martin, the fee goes back to your card within 24 hours. If it isn't there tomorrow, DM us your order number.",
        },
      ],
      [
        2,
        'Sandra V.',
        'Great news for our village, deliveries used to take forever!',
        'P',
        'Happy deliveries are faster in her village',
      ],
      [2.5, 'Ion C.', 'Bravo Tavelo, foarte bine 👏', 'P', 'Praises the launch'],
      [
        4,
        'Rachel A.',
        'When does Lakeside get more restaurants?',
        'Q',
        'Asks when Lakeside gets more choice',
        { re: 'Hi Rachel, 15 new places join in Lakeside early next year.' },
      ],
      [
        6,
        'Derek M.',
        'Will delivery fees go up because of this?',
        'Q',
        'Asks if fees rise with the promise',
        { e: 'worried', re: 'No Derek, the promise comes at no extra cost.' },
      ],
      [
        8,
        'Fatima H.',
        'Pizza in 17 minutes in the old town 😮',
        'P',
        'Shares a fast delivery',
        { e: 'excited' },
      ],
      [
        12,
        'Neil O.',
        "Still nobody delivers to the Ridge road, a promise is useless if you can't order",
        'C',
        'No delivery at all on Ridge road',
        { cat: 'delivery', st: 'u' },
      ],
      [
        20,
        'Joy B.',
        'Can you add delivery to the train station?',
        'S',
        'Asks for delivery to the station',
      ],
      [40, 'Tomas R.', 'Shared with my parents', 'N', 'Shared the post'],
    ],
  },
  {
    net: 'facebook',
    d: 12,
    at: '16:00',
    kind: 'post',
    caption:
      'An update on our fees: from 1 November, the small-order fee on orders under €12 goes from €1.50 to €2.50, and the service fee becomes 5% of the order, capped at €3, to cover higher rider pay. Orders over €15 have no small-order fee, and every fee shows before you pay. Details: tavelo.example/fees',
    description:
      'Tavelo announces a higher small-order fee and a 5% service fee from 1 November, to cover rider pay, with no small-order fee above €15.',
    likes: 96,
    shares: 88,
    views: null,
    extra: 14,
    cs: [
      [
        0.3,
        'Robert K.',
        "So I'm paying more for the same burger. Great.",
        'C',
        'Unhappy about paying more',
        {
          k: 'robert',
          cat: 'price',
          e: 'angry',
          likes: 54,
          re: 'Hi Robert, we understand. Orders over €15 skip the small-order fee, and the change goes to rider pay.',
          rh: 2.2,
        },
      ],
      [
        1.2,
        'Kevin S.',
        "read it again, it's only on small orders",
        'N',
        'Defends the change, points to small orders',
        { k: 'kevin', to: 'robert' },
      ],
      [
        1.5,
        'Robert K.',
        "my usual order IS small, that's the point",
        'C',
        'His usual order is under the limit',
        { to: 'kevin', cat: 'price', r: 0, u: 0 },
      ],
      [
        0.5,
        'Diana P.',
        'I paid for a year of free delivery with a promo in June. Does this cancel it?',
        'C',
        'Worried a paid promo is cancelled',
        {
          cat: 'price',
          u: 2,
          e: 'angry',
          likes: 71,
          re: "Hi Diana, no, promos you already have stay as they are until they end. DM us and we'll confirm yours.",
        },
      ],
      [
        0.8,
        'Mihai D.',
        'Time to delete the app',
        'C',
        'Threatens to leave over the fee rise',
        { cat: 'price', u: 2, e: 'angry', likes: 38 },
      ],
      [
        1,
        'Laura G.',
        'Does this apply to groceries? I order milk for my mum twice a week',
        'Q',
        'Asks if grocery orders are affected',
        {
          e: 'worried',
          re: 'Hi Laura, yes, but grocery orders over €15 have no small-order fee. A few more items keeps it free.',
        },
      ],
      [
        1.6,
        'Agata W.',
        'Rider pay went up? Riders I talk to say the opposite',
        'C',
        'Disputes the reason for the rise',
        { cat: 'price', u: 0, likes: 29, st: 'i' },
      ],
      [
        2,
        'Sean M.',
        'How do I see the fees before ordering?',
        'Q',
        'Asks where fees are shown',
        {
          cat: 'interest',
          re: 'Hi Sean, open the basket: every fee is listed above the Pay button, before you pay.',
        },
      ],
      [
        2.3,
        'Nadia B.',
        "Fair enough, if riders get more I don't mind €1",
        'P',
        'Accepts the rise as fair',
        { cat: 'other-positive', e: 'neutral' },
      ],
      [
        2.5,
        'Hassan E.',
        'Three fee increases in two years. Loyalty means nothing',
        'C',
        'Loyal customer upset by repeated rises',
        { cat: 'price', e: 'disappointed', likes: 33, st: 'u' },
      ],
      [
        3,
        'Clare F.',
        'Will business orders change too?',
        'Q',
        'Asks if business orders change',
        { re: "Hi Clare, Office Lunch orders aren't affected by this change." },
      ],
      [
        3.5,
        'Petr N.',
        'When will I get an email about this?',
        'Q',
        'Asks when the email arrives',
        { st: 'u' },
      ],
      [
        4,
        'Greta J.',
        "I'm a pensioner and order small meals, €1 matters to me. Is there any discount?",
        'C',
        'Pensioner asks for a discount',
        {
          cat: 'price',
          e: 'worried',
          re: "Hi Greta, yes, our Care discount removes the small-order fee for customers over 65. DM us and we'll set it up.",
        },
      ],
      [
        4.5,
        'Owen T.',
        'Can you at least fix the cold food in Northside before charging more',
        'C',
        'Wants cold deliveries fixed first',
        { cat: 'delivery', likes: 19 },
      ],
      [
        5,
        'Bianca L.',
        'Ordered a bit more with my flatmate, no fee now. Thanks for the tip in the comments',
        'P',
        'Found a way to avoid the fee',
        { e: 'grateful' },
      ],
      [
        6,
        'Vlad C.',
        'delete my account then',
        'C',
        'Wants to delete his account over fees',
        { cat: 'price', u: 2, e: 'angry' },
      ],
      [
        7,
        'Emma D.',
        'Do I need to do anything or does it change automatically?',
        'Q',
        'Asks if she needs to act',
        { re: 'Hi Emma, nothing to do, it changes on 1 November.' },
      ],
      [
        8,
        'Frank Z.',
        'classic move. announce it on a friday',
        'C',
        'Sarcastic about the timing',
        { cat: 'price', r: 0, u: 0 },
      ],
      [
        9,
        'Lea M.',
        "how about rewarding customers who've been here 5 years",
        'S',
        'Suggests rewards for loyal customers',
      ],
      [
        10,
        'Arjun P.',
        'Will pick-up orders have the fee too?',
        'Q',
        'Asks if pick-up orders have fees',
        { st: 'u' },
      ],
      [
        12,
        'Crypto Mentor Anna',
        'I made €4,000 last week trading with my mentor, message her on WhatsApp',
        'X',
        'Investment scam spam',
      ],
      [
        14,
        'Sophie R.',
        'Is the service fee also charged on tips?',
        'Q',
        'Asks if the fee applies to tips',
      ],
      [
        20,
        'Marek H.',
        "I'll just order for two from now on 😅",
        'N',
        'Plans bigger orders to avoid the fee',
        { cat: 'interest' },
      ],
      [
        28,
        'Tobias K.',
        'Still waiting for a reply to my DM from Tuesday',
        'C',
        'No answer to a private message for days',
        { cat: 'service' },
      ],
      [
        36,
        'Yvonne A.',
        "Honestly your riders are always lovely, I'll take the extra euro",
        'P',
        'Accepts the rise, praises riders',
      ],
      [
        50,
        'Ken L.',
        "Can I see last month's fees in the app?",
        'Q',
        'Asks about past fees',
        { st: 'u' },
      ],
      [
        60,
        'Elif K.',
        'is the fee going up for groceries also???',
        'Q',
        'Worried grocery fees also rise',
        { e: 'worried' },
      ],
      [70, 'Bogdan S.', 'Unacceptable', 'C', 'Rejects the fee rise', { cat: 'price', e: 'angry' }],
    ],
  },
  {
    net: 'facebook',
    d: 8,
    at: '13:00',
    kind: 'post',
    img: 'balloons',
    caption:
      'Thank you to everyone who came to the Tavelo Kitchen pop-up on Saturday! 🎈 It stays open every weekend this month, with new restaurants each week.',
    description:
      'A thank-you post after the Market Square pop-up, which stays open every weekend this month with new restaurants.',
    likes: 523,
    shares: 12,
    views: null,
    cs: [
      [1, 'Teresa M.', 'Lovely staff and great dumplings 🥟', 'P', 'Praises staff and food'],
      [
        3,
        'Alan G.',
        'Waited 50 minutes in the queue',
        'C',
        'Long wait at the pop-up',
        {
          cat: 'service',
          u: 0,
          re: 'Sorry for the wait, Alan. Sunday mornings are much quieter, and you can pre-order in the app to skip the queue.',
        },
      ],
      [
        4,
        'Mira S.',
        'Found my new favourite bakery thanks to you!',
        'P',
        'Discovered a new bakery',
        { e: 'grateful' },
      ],
      [
        6,
        'Dan C.',
        'Can I order from the pop-up stalls in the app?',
        'Q',
        'Asks about ordering pop-up food in the app',
        { re: 'Hi Dan, yes, they appear under Tavelo Kitchen on weekends.' },
      ],
      [9, 'Lidia F.', 'Kids loved the balloons 😄', 'P', 'Family enjoyed the opening'],
      [
        20,
        'Ray N.',
        'Will you do one in Eastfield?',
        'Q',
        'Asks about a pop-up in Eastfield',
        { st: 'u' },
      ],
    ],
  },
  {
    net: 'facebook',
    d: 4,
    at: '19:30',
    kind: 'post',
    img: 'window',
    caption:
      "Service update, 19:30: since 19:05 a fault at our payment provider is stopping some orders from going through, and some cards were charged twice. Our team is on it, and every double charge will be refunded automatically. We'll update here. We're sorry.",
    description:
      'An incident notice: a payment fault stopped orders and charged some cards twice at dinner time, with automatic refunds promised.',
    likes: 58,
    shares: 140,
    views: null,
    extra: 64,
    grow: 'climb',
    own: [
      [
        2.2,
        'Update 21:40: orders are going through again. Every double charge is being refunded, and everyone affected gets €10 credit. Thank you for bearing with us.',
      ],
    ],
    cs: [
      [
        0.2,
        'Paula N.',
        'Charged twice and no food. I have two hungry kids. This is the second time this month',
        'C',
        'Charged twice, no food, second time',
        {
          k: 'paula',
          cat: 'price',
          u: 2,
          e: 'angry',
          likes: 44,
          re: "Paula, we're really sorry. Orders work again since 21:40, your double charge is refunded and €10 credit is in your account.",
          rh: 2.3,
        },
      ],
      [
        1.3,
        'Nina K.',
        'same here, charged twice',
        'C',
        'Same double charge',
        { to: 'paula', cat: 'price', r: 0 },
      ],
      [
        1.5,
        'Oscar P.',
        'same, nothing in the app either',
        'C',
        'Same failed order',
        { to: 'paula', cat: 'product', r: 0 },
      ],
      [
        0.4,
        'George T.',
        'Will we get the money back?',
        'Q',
        'Asks about refunds for the fault',
        {
          e: 'frustrated',
          u: 1,
          likes: 38,
          re: 'Hi George, yes: every double charge is refunded automatically, nothing to do.',
        },
      ],
      [
        0.6,
        'Irina V.',
        'App says order failed but the restaurant is cooking it?? Who do I pay',
        'C',
        'Order failed but the restaurant is cooking',
        {
          cat: 'product',
          u: 2,
          e: 'angry',
          re: "Sorry Irina. If the restaurant has it, it's on its way and you won't be charged twice. DM us your order number and we'll check.",
        },
      ],
      [
        0.8,
        'Matt B.',
        'Thanks for the update at least',
        'P',
        'Appreciates the incident update',
        { e: 'grateful' },
      ],
      [
        1,
        'Selin Y.',
        "I run a restaurant on Tavelo and we've had zero orders since 7pm, our busiest night",
        'C',
        'Restaurant losing orders during the fault',
        {
          cat: 'service',
          u: 2,
          e: 'angry',
          likes: 26,
          re: "Selin, we're sorry. Please DM us your restaurant ID, our partner team will call you tonight.",
        },
      ],
      [
        1.2,
        'Adam R.',
        "Any update? It's 20:45",
        'Q',
        'Asks for an update on the fault',
        { e: 'frustrated', u: 1, st: 'u' },
      ],
      [
        2,
        'Hannah J.',
        'Why does a payment problem stop cash orders too?',
        'Q',
        'Confused why cash orders fail',
        {
          e: 'confused',
          re: "Hi Hannah, every order is checked with the payment system first, so cash orders were stuck too. We're changing that.",
        },
      ],
      [
        2.2,
        'Liam O.',
        'Respect to the riders still out in this rain',
        'P',
        'Thanks riders working in the rain',
        { likes: 61, e: 'grateful' },
      ],
      [
        2.5,
        'Patrick D.',
        'I want a refund for the whole order, not just the double charge. Food came 2 hours late and cold',
        'C',
        'Wants a full refund for a cold late order',
        { cat: 'delivery', u: 2, e: 'angry', likes: 17 },
      ],
      [
        3,
        'Zara Q.',
        'Is it all cities or only here?',
        'Q',
        'Asks which cities are affected',
        { st: 'u' },
      ],
      [
        3.3,
        'Eva L.',
        'Working again for me in Oakfield!',
        'P',
        'Ordering works again',
        { e: 'happy' },
      ],
      [
        3.6,
        'Ruben S.',
        "my partner's account doesn't work either, same card",
        'C',
        'Second account also fails',
        { cat: 'product', r: 0, u: 0 },
      ],
      [
        4,
        'Cristina B.',
        'Are orders already on their way affected?',
        'Q',
        'Asks if active orders are affected',
        { st: 'u' },
      ],
      [
        2.4,
        'Yannick D.',
        'Still failing in Northgate at 21:55',
        'C',
        'Still failing in Northgate',
        { cat: 'product', r: 0 },
      ],
      [
        5,
        'Mona H.',
        'Kids have been waiting for dinner since 7, what are we supposed to do',
        'C',
        'Family waiting hours for dinner',
        {
          cat: 'delivery',
          u: 2,
          e: 'worried',
          re: 'So sorry, Mona. Orders work again now, and €10 credit is in your account. Thank you for your patience.',
        },
      ],
      [
        5.5,
        'Jonas W.',
        'Food just arrived. Thanks team',
        'P',
        'Order arrived, thanks the team',
        { e: 'grateful' },
      ],
      [
        6,
        'Bernard L.',
        'This app gets worse every year',
        'C',
        'Says the app keeps getting worse',
        { cat: 'product', u: 0, st: 'i' },
      ],
      [
        6.5,
        'Sasha T.',
        'Still no refund for the double charge at 02:00',
        'C',
        'Double charge not refunded yet',
        { cat: 'price', u: 2 },
      ],
      [
        7,
        'Will F.',
        'how do I use the €10 credit',
        'Q',
        'Asks how to use the credit',
        { e: 'curious' },
      ],
      [
        8,
        'Amal R.',
        'Order went through at 21:40, all good now',
        'P',
        'Confirms ordering works again',
      ],
      [
        10,
        'Freddie C.',
        'fix your app before raising fees',
        'C',
        'Links the fault to the fee rise',
        { cat: 'price', e: 'angry', likes: 33 },
      ],
      [
        12,
        'Lucia M.',
        "Support chat says there's no problem?? confusing",
        'C',
        'Support chat denied the fault',
        { cat: 'service', e: 'confused', st: 'u' },
      ],
      [
        20,
        'Oskar N.',
        'Credit showed up in the app already, fair play',
        'P',
        'Received the credit quickly',
      ],
      [
        26,
        'Gemma T.',
        "App keeps logging me out since yesterday's fix",
        'C',
        'App logs out since the fix',
        { cat: 'product' },
      ],
      [
        27,
        'free-crypto-signals',
        '📈 Join our VIP signals group, 300% returns guaranteed',
        'X',
        'Investment scam spam',
      ],
      [
        30,
        'Ahmed S.',
        'When does the double charge refund arrive exactly?',
        'Q',
        'Asks when the refund arrives',
        { e: 'curious' },
      ],
    ],
  },
  {
    net: 'facebook',
    d: 2,
    at: '18:30',
    kind: 'post',
    img: 'wall',
    caption:
      'Tavelo Pass 🍂 Free delivery on every order over €15 and 10% back on groceries, for €4.99/month. First month free, join in the app. Until 31 October.',
    description:
      'Tavelo Pass on Facebook: free delivery on orders over €15 and 10% back on groceries for €4.99 a month, first month free.',
    likes: 301,
    shares: 46,
    views: null,
    cs: [
      [
        0.5,
        'Stella P.',
        'Just joined in the app, took 1 minute 👍',
        'P',
        'Joined quickly in the app',
      ],
      [
        1,
        'Igor M.',
        'Is there a contract or monthly?',
        'Q',
        'Asks about commitment',
        { cat: 'interest', re: "Hi Igor, it's monthly, cancel any time." },
      ],
      [
        2,
        'Bea N.',
        'Can my daughter use my Pass on her account?',
        'Q',
        'Wants to share Pass',
        { cat: 'interest' },
      ],
      [
        3,
        'Ruth H.',
        "Tried joining, app says 'Pass not available for your account'",
        'C',
        'App refuses to add Pass',
        { cat: 'product', e: 'confused' },
      ],
      [
        5,
        'Colin J.',
        '4.99 a month and you raised the fees last month 🙄',
        'C',
        'Annoyed after a recent fee rise',
        { cat: 'price', u: 0 },
      ],
      [
        8,
        'Pia L.',
        'Is it really every order or is there a weekly limit?',
        'Q',
        'Asks about a usage limit',
        { e: 'curious' },
      ],
      [20, 'Andre V.', 'Great deal, joined', 'P', 'Joined the offer', { cat: 'interest' }],
      [
        26,
        'Moses K.',
        'does it work for pick-up orders too?',
        'Q',
        'Asks about pick-up orders',
        { cat: 'interest' },
      ],
    ],
  },

  // TikTok
  {
    net: 'tiktok',
    d: 26,
    at: '19:00',
    kind: 'video',
    img: 'window',
    caption: 'POV: your pad thai arrives still steaming 😌 #fooddelivery #Tavelo',
    description: 'A short comedy video about a delivery arriving hot and fast at a flat window.',
    likes: 1320,
    shares: 64,
    views: 24600,
    extra: 9,
    cs: [
      [
        1,
        'its.mayaa',
        'this is literally me every friday 😭',
        'P',
        'Relates to the video',
        { e: 'happy' },
      ],
      [
        2,
        'buildbybenji',
        'how long does delivery usually take',
        'Q',
        'Asks the usual delivery time',
        { cat: 'interest', re: 'about 25 minutes on average in the city! 🛵' },
      ],
      [3, 'zoe.films', 'the acting 😂😂', 'N', 'Laughs at the video'],
      [
        5,
        'k1ra',
        'still no delivery to my street 😩',
        'C',
        'No delivery to her street',
        {
          cat: 'delivery',
          e: 'disappointed',
          u: 0,
          re: "drop your street in our DMs and we'll check when it's added 👀",
        },
      ],
      [8, 'nightbus.nico', "who's the guy", 'N', 'Asks about the person in the video'],
      [
        12,
        'fern.and.co',
        'is there a minimum order',
        'Q',
        'Asks about a minimum order',
        { st: 'u' },
      ],
      [30, 'lowkey.lex', 'pad thai gang 🫡', 'P', 'Happy customer'],
    ],
  },
  {
    net: 'tiktok',
    d: 21,
    at: '18:00',
    kind: 'video',
    img: 'hands',
    caption:
      '3 ways to get your food hotter and faster 🛵 1. order before 19:00 on Fridays 2. pick places under 2 km 3. add your door code. Save this! #foodtok #lifehacks',
    description:
      'A customer tip video: three ways to get deliveries faster and hotter, from timing to distance and door codes.',
    likes: 3410,
    shares: 512,
    views: 48200,
    extra: 17,
    cs: [
      [
        1,
        'techwithjas',
        'the door code tip changed my life ngl',
        'P',
        'Found the tip useful',
        { likes: 120 },
      ],
      [
        2,
        'dadjokesdaily',
        'my building has no door code, the rider just yells my name 💀',
        'N',
        'Jokes about his building',
        { likes: 88 },
      ],
      [
        3,
        'sami.writes',
        'what if I live far from everything, any delivery deals?',
        'Q',
        'Asks about deals for far addresses',
        { cat: 'interest', re: 'yes! orders over €25 have free delivery up to 5 km 🙌' },
      ],
      [
        4,
        'plantmom.rita',
        'tried all 3 and food still comes cold at night',
        'C',
        'Food still arrives cold at night',
        {
          cat: 'delivery',
          re: "sorry Rita! that shouldn't happen, DM us your last order number and we'll look at it",
        },
      ],
      [
        5,
        'jamie_lee',
        'more videos like this pls',
        'S',
        'Asks for more tip videos',
        { e: 'happy' },
      ],
      [
        8,
        'cosmo.k',
        'why is friday even busier than saturday',
        'Q',
        'Curious about busy days',
        { r: 0 },
      ],
      [12, 'tiny.tech.tips', 'saved ✅', 'P', 'Saved the video'],
      [
        20,
        'erin.mcd',
        'adding a door code is a hack lol, riders should just find it',
        'C',
        'Thinks riders should manage alone',
        { cat: 'delivery', r: 0, u: 0 },
      ],
      [
        40,
        'milo_reads',
        'whats the best time to order on a sunday',
        'Q',
        'Asks the best time to order',
        { re: 'before 12:30 or after 14:00, the lunch rush is wild!' },
      ],
    ],
  },
  {
    net: 'tiktok',
    d: 16,
    at: '17:00',
    kind: 'video',
    img: 'wall-green',
    caption:
      'Building our Tavelo Kitchen pop-up in 60 seconds 🏗️ opening Saturday! #behindthescenes',
    description:
      'A time-lapse of the Tavelo Kitchen pop-up being built on Market Square, ahead of its Saturday opening.',
    likes: 1890,
    shares: 70,
    views: 31800,
    extra: 8,
    cs: [
      [2, 'archi.vibes', 'the lighting in there 😍', 'P', 'Likes the pop-up lighting'],
      [
        3,
        'nolan.ng',
        'will you be hiring?',
        'Q',
        'Asks about jobs at the pop-up',
        { cat: 'other-positive', re: 'we are! check tavelo.example/jobs 🙌' },
      ],
      [6, 'sunny.b', 'time lapse music is a bop', 'P', 'Likes the video music'],
      [
        9,
        'dee.travels',
        'so many pop-ups and still no delivery to my village lol',
        'C',
        'No delivery to her village',
        { cat: 'delivery', u: 0, st: 'u' },
      ],
      [20, 'hugo.paints', 'who did the wall art??', 'Q', 'Asks who made the wall art', { r: 0 }],
    ],
  },
  {
    net: 'tiktok',
    d: 11,
    at: '20:00',
    kind: 'video',
    img: 'dusk',
    caption:
      'We timed 10 deliveries across the city in one evening 🛵 number 7 surprised us. #foodtok #Tavelo',
    description:
      'A video timing ten Tavelo deliveries across the city in one evening, most arriving in under 20 minutes.',
    likes: 8740,
    shares: 1260,
    views: 112400,
    extra: 41,
    cs: [
      [
        0.5,
        'metro.memes',
        'number 7 crossed the river in 9 minutes how is that possible 😳',
        'Q',
        'Surprised by a fast delivery',
        { r: 0, e: 'excited', likes: 340 },
      ],
      [
        1,
        'rob.codes',
        '14 minutes for a pizza across town is wild',
        'P',
        'Impressed by delivery speed',
        { likes: 210, e: 'excited' },
      ],
      [
        1.5,
        'anya.vlogs',
        'do this on a rainy night next!!',
        'S',
        'Asks for a test on a rainy night',
        { likes: 95, e: 'excited' },
      ],
      [
        2,
        'the.real.dom',
        'meanwhile my food takes an hour to get 2 streets',
        'C',
        'Very slow delivery to his home',
        {
          cat: 'delivery',
          likes: 156,
          re: "that's not right Dom! DM us your address and we'll look at your area",
        },
      ],
      [
        3,
        'ziggy.t',
        'which restaurant was number 7',
        'Q',
        'Asks which restaurant was used',
        { re: "the noodle bar on Bridge Street, it's on the app! 🍜" },
      ],
      [3.5, 'kai.m', 'is this sponsored lol', 'N', 'Jokes that the video is sponsored'],
      [
        4,
        'laurenb',
        "ok I'm downloading the app",
        'P',
        'Wants to try the app',
        { cat: 'interest', likes: 77, e: 'excited' },
      ],
      [5, 'petra.fit', 'my lunch break just got longer', 'P', 'Happy with fast lunch delivery'],
      [6, 'noah.z', 'can you time the airport area', 'S', 'Asks for an airport area test'],
      [
        8,
        'cleo.r',
        'how do I get the fast riders lol',
        'Q',
        'Asks how to get fast delivery',
        {
          cat: 'interest',
          re: "pick places under 2 km and add your door code, that's the secret 💜",
        },
      ],
      [
        10,
        'jonny.x',
        'mine said 20 minutes and took 45 today',
        'C',
        'Delivery took twice the estimate',
        { cat: 'delivery', u: 0, st: 'u' },
      ],
      [12, 'best.deals.4u', 'Free iPhone giveaway 🎁 click link in bio', 'X', 'Fake giveaway spam'],
      [16, 'maia.p', 'the editing on this 🔥', 'P', 'Praises the video editing'],
      [
        30,
        'olu.wav',
        'now do this in Northside where nothing arrives hot',
        'C',
        'Cold deliveries in Northside',
        { cat: 'delivery', u: 0 },
      ],
    ],
  },
  {
    net: 'tiktok',
    d: 7,
    at: '18:30',
    kind: 'video',
    img: 'hands',
    caption: 'Follow your rider in 3 taps, no calls, no guessing ⏱️ #foodtok #Tavelo',
    description: 'A short demonstration of following a rider live on the map in the Tavelo app.',
    likes: 6200,
    shares: 830,
    views: 96400,
    extra: 18,
    grow: 'wave',
    cs: [
      [
        1,
        'travel.with.tia',
        'can I share the tracking link with my flatmate?',
        'Q',
        'Asks about sharing tracking',
        { cat: 'interest', re: 'yes! tap Share on the map and send the link 🙌' },
      ],
      [
        2,
        'fixit.felix',
        "the map doesn't move on my phone, keeps saying 'location off'",
        'C',
        'Tracking map does not move',
        {
          cat: 'product',
          e: 'confused',
          re: "turning location on for the app usually fixes it, DM us your phone model and we'll check",
        },
      ],
      [4, 'lily.m', 'so easy wow', 'P', 'Finds tracking easy'],
      [
        6,
        'grandpa.george',
        'my grandson showed me this, I watched my soup cross town',
        'P',
        'Enjoys tracking his order',
      ],
      [12, 'rosie.q', 'does it cost extra?', 'Q', 'Asks if tracking costs extra', { st: 'u' }],
      [
        30,
        'a.k.dev',
        'where do I find it in the app',
        'Q',
        'Cannot find tracking in the app',
        { e: 'confused' },
      ],
    ],
  },
  {
    net: 'tiktok',
    d: 4,
    at: '22:30',
    kind: 'video',
    img: 'dusk',
    caption:
      "What happened tonight, and what we're doing about it. A fault at our payment provider stopped orders and charged some cards twice. Orders work again, double charges are being refunded, and everyone affected gets €10 credit. #Tavelo",
    description:
      'An explainer video about the evening payment fault, with refunds for double charges and €10 credit for affected customers.',
    likes: 980,
    shares: 210,
    views: 41900,
    extra: 12,
    cs: [
      [
        0.5,
        'northside.nat',
        'appreciate you actually explaining it',
        'P',
        'Appreciates the honest explanation',
        { likes: 120, e: 'grateful' },
      ],
      [
        1,
        'j.okoro',
        '€10 credit for losing my whole dinner? 🙄',
        'C',
        'Finds the credit too small',
        { cat: 'price', likes: 89 },
      ],
      [
        1.5,
        'anna.bnn',
        'the riders out tonight deserve a raise',
        'P',
        'Praises riders on the night',
        { likes: 140 },
      ],
      [
        2,
        'callum.w',
        'my order still shows as failed but I was charged',
        'C',
        'Charged for an order still shown failed',
        {
          cat: 'price',
          re: 'sorry Callum! DM us your order number, the charge will be refunded today',
        },
      ],
      [
        2.5,
        'freya.l',
        "why isn't there a backup payment system?",
        'Q',
        'Asks why there is no backup',
        {
          u: 0,
          re: "good question! we're adding a second payment provider, ready before December",
        },
      ],
      [
        3,
        'mr.patel',
        'third time this year the app dies at dinner',
        'C',
        'Third dinner-time failure this year',
        { cat: 'product', e: 'angry' },
      ],
      [4, 'suzie.q', 'the transparency 👏', 'P', 'Praises the transparency'],
      [
        6,
        'dex.music',
        'my whole birthday dinner order died 😭',
        'C',
        'Birthday order lost in the fault',
        { cat: 'delivery', r: 0, u: 0, e: 'disappointed' },
      ],
      [
        8,
        'harper.j',
        'how do I get the credit?',
        'Q',
        'Asks how to get the credit',
        { e: 'curious' },
      ],
      [10, 'tom.builds', 'payments vs dinner, payments win again', 'N', 'Jokes about the cause'],
      [
        14,
        'kemi.a',
        'will this happen again next friday?',
        'Q',
        'Worried about future failures',
        { e: 'worried' },
      ],
      [
        18,
        'leon.vb',
        'Danke for the honesty',
        'P',
        'Thanks the brand for honesty',
        { e: 'grateful' },
      ],
      [20, 'promo.king', 'Follow me for free gift cards 🎁', 'X', 'Gift card spam'],
      [
        40,
        'ava.reads',
        'credit is in my app, thanks',
        'P',
        'Received the credit',
        { e: 'grateful' },
      ],
    ],
  },
  {
    net: 'tiktok',
    d: 1,
    at: '19:00',
    kind: 'video',
    img: 'balloons',
    caption: 'when the birthday cake arrives before the guests 🎈💃 #Tavelo #birthday',
    description:
      'A playful trend video about a birthday cake delivered by Tavelo before the party guests arrive.',
    likes: 1105,
    shares: 58,
    views: 18700,
    extra: 4,
    cs: [
      [0.5, 'bella.mov', 'the dance 😂😂', 'P', 'Enjoys the dance in the video'],
      [
        1,
        'ryan.tk',
        'do bakeries deliver late at night?',
        'Q',
        'Asks about late bakery delivery',
        { cat: 'interest', re: 'many until 23:00! filter by Open late in the app 🙌' },
      ],
      [
        2,
        'hazel.t',
        "finally a delivery app tiktok that's funny",
        'P',
        'Finds the brand video funny',
      ],
      [
        3,
        'max.ortz',
        "app says the bakery is closed but it's open",
        'C',
        'App shows an open bakery as closed',
        { cat: 'product', e: 'confused' },
      ],
      [
        5,
        'sol.a',
        'can I schedule a cake for tomorrow',
        'Q',
        'Asks about scheduling a delivery',
        { cat: 'interest' },
      ],
      [
        8,
        'cami.r',
        "ordering my sister's cake from here",
        'P',
        'Plans to order a cake',
        { cat: 'interest', e: 'excited' },
      ],
      [
        14,
        'dmitri.v',
        'can I add a candle to the order',
        'Q',
        'Asks about adding a candle',
        { e: 'curious' },
      ],
    ],
  },
]

// --- Helpers -----------------------------------------------------------------------------

/** A small seeded random: the same numbers on every run. */
let seed = 20261013
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const digits = (n: number, first = '') => {
  let s = first
  while (s.length < n) s += Math.floor(rand() * 10)
  return s
}
const code = (n: number) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  return Array.from({ length: n }, () => abc[Math.floor(rand() * abc.length)]).join('')
}
const iso = (ms: number) => new Date(ms).toISOString()
const H = 3600_000
const NOW = Date.now()

/** Local time HH:MM, `d` days before today. */
function localAt(d: number, at: string) {
  const [h, m] = at.split(':').map(Number)
  const t = new Date(NOW)
  t.setDate(t.getDate() - d)
  t.setHours(h!, m!, 0, 0)
  return t.getTime()
}

const DEFAULTS: Record<L, { label: string; r: 0 | 1; u: 0 | 1 | 2; e: string }> = {
  P: { label: 'praise', r: 0, u: 0, e: 'happy' },
  Q: { label: 'question', r: 1, u: 0, e: 'curious' },
  C: { label: 'complaint', r: 1, u: 1, e: 'frustrated' },
  S: { label: 'suggestion', r: 0, u: 0, e: 'neutral' },
  N: { label: 'neutral', r: 0, u: 0, e: 'neutral' },
  X: { label: 'spam', r: 0, u: 0, e: 'neutral' },
}

function sentimentOf(
  l: L,
  cat?: string,
): ['positive' | 'negative' | 'neutral' | null, string | null] {
  if (l === 'X') return [null, null]
  if (l === 'C') return ['negative', cat ?? 'other-negative']
  if (l === 'P') return ['positive', cat ?? 'thanks']
  if (cat && POSITIVE.has(cat)) return ['positive', cat]
  return ['neutral', null]
}

// --- Build -------------------------------------------------------------------------------

async function main() {
  if (resolve(DEMO) === resolve(root, 'data')) throw new Error('Refusing to write into data/.')
  rmSync(DEMO, { recursive: true, force: true })
  mkdirSync(DEMO, { recursive: true })

  const { openDb, closeAnswered } = await import('../apps/app/src/core/db.ts')
  const store = await import('../apps/app/src/core/store.ts')
  const { buildReport } = await import('../apps/app/src/core/report.ts')
  const auth = await import('../apps/app/src/core/auth.ts')

  const db = openDb()

  // The person who signs in.
  const password = randomBytes(15).toString('base64url')
  const user = auth.createUser(db, {
    email: 'elena@tavelo.example',
    name: 'Elena Marsh',
    username: 'elena',
    password,
    super: true,
    verified: true,
  })
  writeFileSync(
    join(DEMO, 'CREDENTIALS.txt'),
    `Demo dashboard sign-in (data/demo only)\nemail: ${user.email}\nusername: elena\npassword: ${password}\n`,
    { mode: 0o600 },
  )

  // The brand and its three profiles.
  const brand = store.addBrand(
    db,
    BRAND,
    [
      `https://www.instagram.com/${HANDLE}`,
      `https://www.facebook.com/${HANDLE}`,
      `https://www.tiktok.com/@${HANDLE}`,
    ],
    'https://tavelo.example',
  )
  store.updateBrand(db, brand.id, {
    industry: 'Food delivery app',
    description:
      'Tavelo delivers from 1,800 local restaurants and grocers in 12 cities, by bike and scooter, usually within 30 minutes.',
    notes:
      'Answer in a warm, plain tone and sign with a first name. Never promise a delivery time the restaurant has not confirmed.',
  })
  store.setTrackers(db, brand.id, [
    { term: 'Tavelo Pass', kind: 'product' },
    { term: 'tracking', kind: 'product' },
    { term: 'Office Lunch', kind: 'product' },
    { term: 'pop-up', kind: 'product' },
    { term: 'fee', kind: 'topic' },
    { term: 'refund', kind: 'topic' },
    { term: 'cold', kind: 'topic' },
    { term: 'rider', kind: 'topic' },
  ])
  db.prepare('UPDATE brands SET alert_emails = ?, created_at = ? WHERE id = ?').run(
    JSON.stringify(['care@tavelo.example', 'social@tavelo.example']),
    iso(localAt(29, '09:40')),
    brand.id,
  )
  const profiles = Object.fromEntries(
    store.listProfiles(db, brand.id).map((p) => [p.network, p]),
  ) as Record<Net, Profile>

  // Every post and comment, with its time, ids and links.
  interface Row {
    post: PostWork
    ext: string
    parent: string | null
    author: string
    text: string
    likes: number
    at: number
    own: boolean
    l?: L
    reason?: string
    o: Opt
  }
  interface PostWork extends PostIn {
    ext: string
    url: string
    at0: number
    thumb: string | null
    rows: Row[]
    id?: number
  }
  const ownName = (n: Net) => (n === 'facebook' ? BRAND : HANDLE)
  const commentId = (n: Net) =>
    n === 'instagram' ? digits(17, '179') : n === 'tiktok' ? digits(19, '74') : digits(16, '10')
  const lastRun = NOW - 47 * 60_000

  const posts: PostWork[] = POSTS.map((p) => {
    const ext =
      p.net === 'instagram' ? code(11) : p.net === 'tiktok' ? digits(19, '74') : digits(16, '12')
    const url =
      p.net === 'instagram'
        ? `https://www.instagram.com/${p.kind === 'reel' ? 'reel' : 'p'}/${ext}/`
        : p.net === 'tiktok'
          ? `https://www.tiktok.com/@${HANDLE}/video/${ext}`
          : `https://www.facebook.com/${HANDLE}/posts/${ext}`
    let thumb: string | null = null
    if (p.img) {
      const dir = join(DEMO, 'media', p.net)
      mkdirSync(dir, { recursive: true })
      copyFileSync(join(PHOTOS, `${p.img}-800.webp`), join(dir, `${ext}.webp`))
      thumb = `/media/${p.net}/${ext}.webp`
    }
    const w: PostWork = { ...p, ext, url, at0: localAt(p.d, p.at), thumb, rows: [] }
    // Comments on recent posts are squeezed into the time since they went out.
    const maxH = Math.max(
      ...p.cs.map(([h, , , , , o]) => h + (o?.re ? (o.rh ?? 1.2) : 0)),
      ...(p.own ?? []).map(([h]) => h),
    )
    const room = (lastRun - 6 * 60_000 - w.at0) / H
    const k = maxH > room ? room / maxH : 1
    const keys = new Map<string, string>()
    for (const [h, author, text, l, reason, o = {}] of p.cs) {
      const ext = commentId(p.net)
      if (o.k) keys.set(o.k, ext)
      const likes = o.likes ?? Math.floor(rand() ** 2.2 * 9)
      w.rows.push({
        post: w,
        ext,
        parent: o.to ? keys.get(o.to)! : null,
        author,
        text,
        likes,
        at: w.at0 + h * k * H + Math.floor(rand() * 600_000),
        own: false,
        l,
        reason,
        o,
      })
      if (o.re)
        w.rows.push({
          post: w,
          ext: commentId(p.net),
          parent: ext,
          author: ownName(p.net),
          text: o.re,
          likes: Math.floor(rand() * 4),
          at: w.at0 + (h + (o.rh ?? 1.2)) * k * H + Math.floor(rand() * 900_000),
          own: true,
          o: {},
        })
    }
    for (const [h, text] of p.own ?? [])
      w.rows.push({
        post: w,
        ext: commentId(p.net),
        parent: null,
        author: ownName(p.net),
        text,
        likes: 12,
        at: w.at0 + h * k * H,
        own: true,
        o: {},
      })
    return w
  })

  // Updates: by hand for the first weeks, then on schedule at 08:00 and 17:00, and one just now.
  const manual = [
    [28, '16:10'],
    [25, '09:40'],
    [22, '14:05'],
    [19, '15:30'],
    [16, '10:20'],
    [13, '11:45'],
    [11, '09:15'],
    [9, '16:45'],
  ].map(([d, at]) => ({ t: localAt(d as number, at as string), trigger: 'manual' as const }))
  const scheduled: { t: number; trigger: 'schedule' | 'manual' }[] = []
  for (let d = 7; d >= 0; d--)
    for (const at of ['08:00', '17:00']) {
      const t = localAt(d, at) + Math.floor(rand() * 11 * 60_000)
      if (t < lastRun - 30 * 60_000) scheduled.push({ t, trigger: 'schedule' })
    }
  const runs = [...manual, ...scheduled, { t: lastRun, trigger: 'manual' as const }].sort(
    (a, b) => a.t - b.t,
  )

  const all = posts.flatMap((p) => p.rows)
  const done = new Set<Row>()
  const finished = new Set<Row>()
  /** A post's numbers at time t, on its growth curve (see PostIn.grow). */
  const WAVE = NOW - 2.5 * 86400_000
  function numbers(p: PostWork, t: number) {
    const age = Math.max(0, t - p.at0)
    const fast = 1 - Math.exp(-age / (18 * H))
    const g = p.grow === 'wave' ? 0.45 * fast + 0.55 / (1 + Math.exp(-(t - WAVE) / (30 * H))) : fast
    const at = (v: number | null) => (v === null ? null : Math.max(1, Math.round(v * g)))
    const kept = p.rows.filter((r) => r.at <= t).length
    const total = p.rows.length + (p.extra ?? 0)
    const c = p.grow === 'climb' ? Math.min(1, age / (lastRun - p.at0)) ** 0.6 : g
    return {
      likes: at(p.likes),
      comments: Math.max(kept, Math.round(total * c)),
      shares: at(p.shares),
      views: at(p.views),
    }
  }
  const NAME: Record<Net, string> = {
    instagram: 'instagram',
    facebook: 'facebook',
    tiktok: 'tiktok',
  }
  const clock = (ms: number) => iso(ms).slice(11, 19)

  for (const [i, run] of runs.entries()) {
    const T = run.t
    let tick = T + 2000
    const log: string[] = [`${clock(T)} Starting.`]
    const touched: number[] = []
    const sorting: [number, string][] = []
    for (const net of ['instagram', 'facebook', 'tiktok'] as Net[]) {
      tick += 3000 + rand() * 4000
      log.push(`${clock(tick)} ${BRAND}: reading ${NAME[net]} @${HANDLE}.`)
      for (const p of posts.filter((x) => x.net === net && x.at0 <= T)) {
        const fresh = p.rows.filter((r) => r.at <= T && !done.has(r))
        if (p.id && !fresh.length) continue
        const now = numbers(p, T)
        const { post } = store.savePost(db, profiles[net], {
          ext_id: p.ext,
          url: p.url,
          posted_at: iso(p.at0),
          kind: p.kind,
          caption: p.caption,
          thumb_url: p.thumb,
          likes: now.likes,
          comments_count: now.comments,
          shares: now.shares,
          views: now.views,
          comments: fresh.map((r) => ({
            ext_id: r.ext,
            parent_ext_id: r.parent,
            author: r.author,
            text: r.text,
            likes: r.likes,
            posted_at: iso(r.at),
            author_url:
              net === 'instagram'
                ? `https://www.instagram.com/${r.author}/`
                : net === 'tiktok'
                  ? `https://www.tiktok.com/@${r.author}`
                  : null,
          })),
        })
        tick += 4000 + rand() * 9000
        const at = iso(tick)
        db.prepare(
          'UPDATE posts SET fetched_at = ?, people_read_at = CASE WHEN people_read_at IS NULL THEN NULL ELSE ? END WHERE id = ?',
        ).run(at, at, post.id)
        db.prepare('UPDATE comments SET fetched_at = ? WHERE post_id = ? AND fetched_at > ?').run(
          at,
          post.id,
          at,
        )
        if (!p.id) {
          p.id = post.id
          store.setDescription(db, post.id, p.description)
        }
        touched.push(post.id)
        if (fresh.length) log.push(`${clock(tick)}   ${fresh.length} new comments on ${p.url}`)
        const toSort = fresh.filter((r) => !r.own)
        if (toSort.length) sorting.push([toSort.length, p.url])
        for (const r of toSort) {
          const cid = (
            db
              .prepare('SELECT id FROM comments WHERE post_id = ? AND ext_id = ?')
              .get(post.id, r.ext) as {
              id: number
            }
          ).id
          const d = DEFAULTS[r.l!]
          const label = d.label as Parameters<typeof store.setVerdict>[2]
          store.setVerdict(db, cid, label, !!(r.o.r ?? d.r), r.reason!, r.o.u ?? d.u, r.o.e ?? d.e)
          const [s, cat] = sentimentOf(r.l!, r.o.cat)
          if (s) store.setSentiment(db, cid, s, cat, 'ai')
        }
        for (const r of fresh) done.add(r)
      }
    }
    for (const [n, url] of sorting) {
      tick += 6000 + rand() * 12000
      log.push(`${clock(tick)} Sorting ${n} comments on ${url}`)
    }
    // Comments a person marked answered or skipped, a few hours after they came in.
    for (const r of all.filter((r) => r.o.st && done.has(r) && !finished.has(r))) {
      const when = r.at + (3 + rand() * 15) * H
      if (when > T) continue
      const cid = (
        db
          .prepare('SELECT c.id FROM comments c WHERE c.post_id = ? AND c.ext_id = ?')
          .get(r.post.id!, r.ext) as {
          id: number
        }
      ).id
      store.setReplyStatus(db, cid, r.o.st === 'u' ? 'done' : 'ignored', user.id)
      db.prepare(
        'UPDATE comments SET answered_at = CASE WHEN answered_at IS NULL THEN NULL ELSE ? END WHERE id = ?',
      ).run(iso(when), cid)
      finished.add(r)
    }
    closeAnswered(db)

    const scope: RunScope = {
      brandIds: [brand.id],
      networks: ['instagram', 'facebook', 'tiktok'],
      range: i === 0 ? 'all' : 'new',
      limit: run.trigger === 'schedule' ? 10 : 5,
    }
    const { text, stats } = buildReport(db, scope, iso(T), touched, [], [])
    tick += 3000
    log.push(`${clock(tick)} Done.`)
    db.prepare(
      `INSERT INTO runs (trigger, scope, started_at, finished_at, status, log, stats, report)
       VALUES (?, ?, ?, ?, 'ok', ?, ?, ?)`,
    ).run(
      run.trigger,
      JSON.stringify(scope),
      iso(T),
      iso(tick),
      log.join('\n') + '\n',
      JSON.stringify(stats),
      text,
    )
  }

  // Each post's history: re-read at every update in its first week (plus a few readings a day),
  // weekly up to 30 days, monthly after, as the app's re-check tiers do. A row only when a number
  // changed; the post keeps the numbers of its newest reading.
  db.exec('DELETE FROM post_metrics')
  const DAY = 86400_000
  const insert = db.prepare(
    'INSERT INTO post_metrics (post_id, at, likes, comments, shares, views) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const p of posts) {
    const extra = [1, 3].map((h) => p.at0 + h * H)
    for (let d = 0; d < 7; d++)
      for (const at of ['08:00', '12:30', '17:00', '21:00']) {
        const [h, m] = at.split(':').map(Number)
        const t = new Date(p.at0)
        t.setDate(t.getDate() + d)
        t.setHours(h!, m!, 0, 0)
        extra.push(t.getTime() + Math.floor(rand() * 9 * 60_000))
      }
    const times = [...new Set([...runs.map((r) => r.t), ...extra])]
      .filter((t) => t > p.at0 + 20 * 60_000 && t <= lastRun)
      .sort((a, b) => a - b)
    let last = -Infinity
    let prev = ''
    let read = p.at0
    for (const t of times) {
      const age = t - p.at0
      if (age >= 30 * DAY ? t - last < 30 * DAY : age >= 7 * DAY && t - last < 7 * DAY) continue
      last = read = t
      const n = numbers(p, t)
      const key = JSON.stringify(n)
      if (key === prev) continue
      prev = key
      insert.run(p.id!, iso(t), n.likes, n.comments, n.shares, n.views)
    }
    const n = numbers(p, read)
    db.prepare(
      'UPDATE posts SET likes = ?, comments_count = ?, shares = ?, views = ?, metrics_at = ? WHERE id = ?',
    ).run(n.likes, n.comments, n.shares, n.views, iso(read), p.id!)
  }

  // Freshness: every profile read in the last update; the signed-in read before the 4-hour gap.
  const last = db.prepare('SELECT finished_at FROM runs ORDER BY id DESC LIMIT 1').get() as {
    finished_at: string
  }
  const session = runs.filter((r) => r.t < NOW - 4.5 * H).at(-1)!.t + 150_000
  db.prepare(
    "UPDATE profiles SET last_run_at = ?, last_status = 'ok', last_error = NULL, last_session_at = ? WHERE brand_id = ?",
  ).run(last.finished_at, iso(session), brand.id)

  // Schedules: twice a day on every network, and a paused extra TikTok check.
  const daily = store.saveSchedule(db, {
    brand_id: brand.id,
    kind: 'times',
    times: ['08:00', '17:00'],
    networks: ['instagram', 'facebook', 'tiktok'],
    range: 'new',
  })
  const next = [0, 1]
    .flatMap((d) => ['08:00', '17:00'].map((at) => localAt(-d, at)))
    .filter((t) => t > NOW)
    .sort((a, b) => a - b)[0]!
  store.setNextRun(db, daily.id, iso(next + 4 * 60_000))
  store.saveSchedule(db, {
    brand_id: brand.id,
    kind: 'interval',
    every_hours: 6,
    networks: ['tiktok'],
    range: 'new',
    enabled: false,
  })

  // Nothing here may make the server reach out on start (see fillTikTok).
  const pending = db
    .prepare(
      `SELECT count(*) AS n FROM posts p WHERE p.network = 'tiktok' AND p.people_read_at IS NULL
         AND EXISTS (SELECT 1 FROM comments c WHERE c.post_id = p.id AND c.author_avatar IS NULL)`,
    )
    .get() as { n: number }
  if (pending.n)
    throw new Error('TikTok posts left for the photo filler; the server would fetch them.')

  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  console.log(
    `Tavelo demo in ${DEMO}: ${n('SELECT count(*) AS n FROM posts')} posts, ${n('SELECT count(*) AS n FROM comments')} comments (${n("SELECT count(*) AS n FROM comments WHERE needs_reply = 1 AND reply_status = 'open'")} waiting), ${n('SELECT count(*) AS n FROM runs')} updates. Sign-in: data/demo/CREDENTIALS.txt`,
  )
  db.close()
}

await main()
