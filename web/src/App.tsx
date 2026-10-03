import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  ArrowLeftRight, ChartColumn, Bell, Briefcase, CalendarCheck, Home, Layers, LayoutDashboard, Lightbulb, Menu, PieChart,
  ChartCandlestick, Settings2, ShieldCheck, Tags, TrendingUp, Umbrella, Wallet, X, type LucideIcon,
} from 'lucide-react';
import { api, type Alert } from './api';
import { useFilters, useMeta } from './state';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import Budgets from './pages/Budgets';
import Cashflow from './pages/Cashflow';
import Businesses from './pages/Businesses';
import Savings from './pages/Savings';
import Loans from './pages/Loans';
import Insights from './pages/Insights';
import Settings from './pages/Settings';
import Events from './pages/Events';
import Categories from './pages/Categories';
import Fixed from './pages/Fixed';
import Trends from './pages/Trends';
import Insurance from './pages/Insurance';
import Pension from './pages/Pension';
import Investments from './pages/Investments';
import { Picker, Segmented } from './components/ui';
import { AgentChat } from './components/AgentChat';
import { desktop, useDesktopNavigation } from './desktop';
import { MasterPasswordDialog } from './components/MasterPassword';
import Welcome from './pages/Welcome';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { MemberAvatar } from '@/lib/visuals';
import { cn } from '@/lib/utils';

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'סקירה', icon: LayoutDashboard },
  { to: '/transactions', label: 'תנועות', icon: ArrowLeftRight },
  { to: '/fixed', label: 'קבועות החודש', icon: CalendarCheck },
  { to: '/budgets', label: 'תקציב', icon: PieChart },
  { to: '/trends', label: 'מגמות הוצאות', icon: ChartColumn },
  { to: '/cashflow', label: 'תזרים ותחזית', icon: TrendingUp },
  { to: '/insights', label: 'תובנות והתראות', icon: Lightbulb },
  { to: '/events', label: 'אירועים ותגיות', icon: Tags },
  { to: '/businesses', label: 'עסקים', icon: Briefcase },
  { to: '/savings', label: 'חסכונות והון', icon: Wallet },
  { to: '/investments', label: 'השקעות', icon: ChartCandlestick },
  { to: '/pension', label: 'פנסיה וגמל', icon: Umbrella },
  { to: '/loans', label: 'הלוואות ומשכנתא', icon: Home },
  { to: '/insurance', label: 'ביטוחים', icon: ShieldCheck },
  { to: '/categories', label: 'קטגוריות', icon: Layers },
  { to: '/settings', label: 'הגדרות', icon: Settings2 },
];

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    cb => { const m = window.matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function FilterBar() {
  const { filters, setFilters } = useFilters();
  const { data: meta } = useMeta();
  if (!meta) return <div className="h-9" aria-hidden />;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented value={filters.memberId} onChange={memberId => setFilters({ ...filters, memberId })}
        className="max-md:flex max-md:w-full max-md:flex-nowrap max-md:[&>*]:flex-1 max-md:[&>*]:px-2"
        options={[
          { value: undefined as number | undefined, label: 'כל הבית' },
          ...meta.members.map(m => ({ value: m.id as number | undefined, label: <><MemberAvatar name={m.name} color={m.color} size={18} />{m.name}</> })),
        ]} />
      {meta.businesses.length > 0 && (
        <Picker className="input w-auto min-w-36 max-md:min-w-0 max-md:flex-1" aria-label="עסק"
          value={filters.businessId != null ? String(filters.businessId) : ''}
          onChange={v => setFilters({ ...filters, businessId: v ? Number(v) : undefined })}
          options={[{ value: '', label: 'כל העסקים', icon: <Briefcase /> }, ...meta.businesses.map(b => ({ value: String(b.id), label: b.name, icon: <Briefcase style={{ color: b.color ?? undefined }} /> }))]} />
      )}
      {meta.tags.length > 0 && (
        <Picker className="input w-auto min-w-32 max-md:min-w-0 max-md:flex-1" aria-label="תגית" value="" placeholder="+ תגית" searchPlaceholder="חיפוש תגית…"
          onChange={v => v && setFilters({ ...filters, tagIds: [...new Set([...filters.tagIds, Number(v)])] })}
          options={[{ value: '', label: '+ תגית', icon: <Tags /> }, ...meta.tags.filter(t => !filters.tagIds.includes(t.id)).map(t => ({ value: String(t.id), label: `#${t.name}`, icon: <Tags /> }))]} />
      )}
      {filters.tagIds.map(id => (
        <motion.button key={id} type="button" layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }}
          className="chip min-h-7 gap-1.5 border border-primary/25 bg-primary/10 px-2 text-primary hover:bg-primary/15"
          onClick={() => setFilters({ ...filters, tagIds: filters.tagIds.filter(x => x !== id) })}>
          #{meta.tags.find(t => t.id === id)?.name}
          <X className="h-3 w-3 opacity-70" />
        </motion.button>
      ))}
    </div>
  );
}

function BrandMark() {
  return (
    <span aria-hidden className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[0.625rem] text-sm font-bold text-white shadow-lg shadow-indigo-500/30"
      style={{ background: 'linear-gradient(135deg, var(--chart-6), var(--chart-1) 55%, var(--chart-5))' }}>
      <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.45),transparent_55%)]" />
      <span className="relative">₪</span>
    </span>
  );
}

function AlertsBell({ unseen }: { unseen: number }) {
  return (
    <Link to="/insights" aria-label="התראות" className="btn-ghost btn-icon relative text-fg-muted">
      <motion.span animate={unseen ? { rotate: [0, -14, 12, -8, 0] } : {}} transition={{ duration: 0.9, delay: 0.6 }} className="inline-flex">
        <Bell className="h-[1.15rem] w-[1.15rem]" />
      </motion.span>
      {unseen > 0 && (
        <span className="num absolute end-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white ring-2 ring-background">
          {unseen}
        </span>
      )}
    </Link>
  );
}

export default function App() {
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  useDesktopNavigation();
  const { data: meta } = useMeta();
  // the desktop app's first run: the setup wizard until it is finished or skipped
  const needsOnboarding = !!desktop && !!meta && meta.settings.onboarding_done !== '1';
  const isTabletUp = useMediaQuery('(min-width: 768px)');
  const isRail = useMediaQuery('(min-width: 768px) and (max-width: 1023px)');
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const { data: alerts } = useQuery({ queryKey: ['alerts', 'open'], queryFn: () => api.get<Alert[]>('/alerts') });
  const unseen = alerts?.filter(a => !a.seenAt).length ?? 0;
  const drawerMode = !isTabletUp;
  const current = NAV.find(n => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)));

  useEffect(() => { if (isTabletUp) setNavOpen(false); }, [isTabletUp]);

  useEffect(() => {
    if (!navOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    drawer.current?.querySelector<HTMLElement>('a[aria-current="page"], a')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
      if (e.key === 'Tab' && drawer.current) {
        const items = [...drawer.current.querySelectorAll<HTMLElement>('a, button')];
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const button = menuButton.current;
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      button?.focus({ preventScroll: true });
    };
  }, [navOpen]);

  return (
    <div className="min-h-dvh md:flex">
      <div aria-hidden onClick={() => setNavOpen(false)}
        className={`fixed inset-0 z-40 bg-[oklch(0.2_0.04_272/0.5)] backdrop-blur-[2px] transition-opacity duration-(--duration-slow) ease-(--ease-out) md:hidden ${navOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`} />

      <aside ref={drawer} id="app-nav" aria-label="ניווט ראשי"
        role={drawerMode ? 'dialog' : undefined} aria-modal={drawerMode && navOpen ? true : undefined}
        inert={drawerMode && !navOpen}
        className={cn('fixed inset-y-0 start-0 z-50 flex w-[min(18rem,86vw)] flex-col bg-sidebar text-sidebar-foreground',
          'max-md:transition-[translate,box-shadow] max-md:duration-(--duration-slow) max-md:ease-(--ease-out) motion-transform',
          navOpen ? 'translate-x-0 shadow-(--shadow-overlay)' : 'translate-x-full',
          'md:sticky md:top-0 md:z-auto md:h-dvh md:w-(--rail-w) md:shrink-0 md:translate-x-0 lg:w-(--sidebar-w)')}>
        {/* glow */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-48 opacity-70"
          style={{ background: 'radial-gradient(120% 80% at 50% 0%, color-mix(in oklab, var(--chart-1) 30%, transparent), transparent 70%)' }} />

        <div className="relative flex h-(--header-h) shrink-0 items-center gap-2.5 px-4 pt-[env(safe-area-inset-top)] md:justify-center md:px-0 lg:justify-start lg:px-5">
          <BrandMark />
          <span className="truncate text-[0.9375rem] font-bold tracking-tight text-white md:max-lg:sr-only">הכספים של הבית</span>
          <button type="button" className="btn-ghost btn-icon ms-auto text-sidebar-foreground hover:bg-sidebar-accent hover:text-white md:hidden"
            aria-label="סגור תפריט" onClick={() => setNavOpen(false)}>
            <X />
          </button>
        </div>

        <nav className="relative flex-1 overflow-y-auto px-2.5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 md:max-lg:overflow-visible lg:px-3">
          <ul className="space-y-0.5">
            {NAV.map(n => {
              const Icon = n.icon;
              const link = (
                <NavLink to={n.to} end={n.to === '/'} onClick={() => setNavOpen(false)}
                  className={({ isActive }) => cn('group relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-(--duration-fast)',
                    'md:h-10 md:justify-center md:px-0 lg:h-9 lg:justify-start lg:px-2.5',
                    isActive ? 'font-semibold text-white' : 'text-sidebar-foreground hover:bg-white/[0.05] hover:text-white')}>
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <motion.span layoutId="nav-active" aria-hidden transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                          className="absolute inset-0 rounded-lg bg-sidebar-accent shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                          <span className="absolute inset-y-2 start-0 w-[3px] rounded-full bg-gradient-to-b from-[var(--chart-5)] to-[var(--chart-6)]" />
                        </motion.span>
                      )}
                      <Icon className={cn('relative h-[1.1rem] w-[1.1rem] shrink-0 transition-[color,transform] duration-(--duration-base) group-hover:scale-110',
                        isActive ? 'text-sidebar-primary' : 'text-sidebar-muted group-hover:text-sidebar-foreground')} />
                      <span className="relative flex-1 truncate md:max-lg:sr-only">{n.label}</span>
                      {n.to === '/insights' && unseen > 0 && (
                        <span className="num relative flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[0.6875rem] font-semibold leading-none text-white
                          md:max-lg:absolute md:max-lg:end-1 md:max-lg:top-1 md:max-lg:h-4 md:max-lg:min-w-4 md:max-lg:text-[0.625rem]">
                          {unseen}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              );
              return (
                <li key={n.to}>
                  {isRail ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="left">{n.label}</TooltipContent>
                    </Tooltip>
                  ) : link}
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b bg-background/75 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
          <div className="flex min-h-(--header-h) items-center gap-2 px-3 py-2.5 sm:px-6 lg:px-8">
            <button ref={menuButton} type="button" className="btn-ghost btn-icon -ms-1 text-fg md:hidden" aria-label="פתח תפריט"
              aria-expanded={navOpen} aria-controls="app-nav" onClick={() => setNavOpen(true)}>
              <Menu className="h-5 w-5" />
            </button>
            <span className="flex min-w-0 items-center gap-2 truncate text-[0.9375rem] font-bold tracking-tight md:hidden">
              {current && <current.icon className="h-4 w-4 text-primary" />}
              {current?.label ?? 'הכספים של הבית'}
            </span>
            <div className="hidden min-w-0 flex-1 md:block"><FilterBar /></div>
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <MasterPasswordDialog />
              <AgentChat />
              <AlertsBell unseen={unseen} />
            </div>
          </div>
        </header>
        <div className="border-b bg-background/60 px-4 py-3 sm:px-6 md:hidden"><FilterBar /></div>

        <main className="mx-auto w-full max-w-[92rem] px-4 pb-16 pt-5 sm:px-6 md:pt-7 lg:px-8 lg:pt-8">
          {/* CSS entry (backwards fill) leaves no transform behind, so fixed children stay viewport-relative */}
          <div key={pathname} className="animate-page-in">
            {needsOnboarding && pathname !== '/welcome' && <Navigate to="/welcome" replace />}
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="/fixed" element={<Fixed />} />
              <Route path="/budgets" element={<Budgets />} />
              <Route path="/trends" element={<Trends />} />
              <Route path="/insurance" element={<Insurance />} />
              <Route path="/pension" element={<Pension />} />
              <Route path="/investments" element={<Investments />} />
              <Route path="/cashflow" element={<Cashflow />} />
              <Route path="/insights" element={<Insights />} />
              <Route path="/events" element={<Events />} />
              <Route path="/businesses" element={<Businesses />} />
              <Route path="/savings" element={<Savings />} />
              <Route path="/loans" element={<Loans />} />
              <Route path="/categories" element={<Categories />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/welcome" element={<Welcome />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}
