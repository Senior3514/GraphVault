import { redirect } from 'next/navigation';

/** The app opens straight into the vault. */
export default function HomePage() {
  redirect('/vault');
}
