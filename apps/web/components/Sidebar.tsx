'use client';

/** Primary app navigation. Dark-first, content-forward per DESIGN.md. */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/vault', label: 'Vault', hint: 'Notes & editor' },
  { href: '/sync-status', label: 'Sync', hint: 'Status & conflicts' },
  { href: '/settings', label: 'Settings', hint: 'Server & vault' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="px-4 py-5">
        <Link href="/vault" className="block">
          <span className="text-lg font-semibold tracking-tight text-neutral-100">
            GraphVault
          </span>
        </Link>
        <p className="mt-1 text-xs text-neutral-500">Local-first notes</p>
      </div>

      <ul className="flex-1 space-y-1 px-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={[
                  'block rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-neutral-800/80 text-neutral-100'
                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200',
                ].join(' ')}
              >
                <span className="font-medium">{item.label}</span>
                <span className="block text-xs text-neutral-500">{item.hint}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-neutral-800 px-4 py-3 text-xs text-neutral-600">
        v0 · web shell
      </div>
    </nav>
  );
}
