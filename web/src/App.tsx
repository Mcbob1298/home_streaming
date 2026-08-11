import { Link, Route, Routes } from 'react-router-dom';

import { Home } from './pages/Home';
import { LibraryPage } from './pages/LibraryPage';
import { MoviePage } from './pages/MoviePage';
import { ReviewPage } from './pages/ReviewPage';
import { ShowPage } from './pages/ShowPage';

export function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-900 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-sm font-medium tracking-wide text-zinc-300 hover:text-zinc-100">
            Bibliothèque
          </Link>
          <Link to="/review" className="text-xs text-zinc-500 hover:text-zinc-300">
            Associations à trancher
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/library/:libraryId" element={<LibraryPage />} />
          <Route path="/movie/:id" element={<MoviePage />} />
          <Route path="/show/:id" element={<ShowPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="*" element={<p className="py-16 text-center text-zinc-500">Page introuvable.</p>} />
        </Routes>
      </main>
    </div>
  );
}
