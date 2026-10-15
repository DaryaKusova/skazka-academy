import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Академия лидеров · Сказка', description: 'Обучение, практика и новые возможности.', icons: { icon: '/favicon.svg' } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ru"><body>{children}</body></html>; }
