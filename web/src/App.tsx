import { Route, Routes, useLocation } from 'react-router-dom';

import { TopNav } from './components/TopNav';
import { GenresPage } from './pages/GenresPage';
import { Home } from './pages/Home';
import { HomePage } from './pages/HomePage';
import { LibraryPage } from './pages/LibraryPage';
import { MoviePage } from './pages/MoviePage';
import { PreparationPage } from './pages/PreparationPage';
import { ReviewPage } from './pages/ReviewPage';
import { SearchPage } from './pages/SearchPage';
import { ShowPage } from './pages/ShowPage';
import { TileDemoPage } from './pages/TileDemoPage';
import { WatchPage } from './pages/WatchPage';

/**
 * Quatre gabarits.
 *
 * Le lecteur n'en a aucun : il occupe l'écran entier, sans barre de
 * navigation. Une barre fixe par-dessus une vidéo plein écran n'aurait pas de
 * sens, et ses raccourcis clavier entreraient en conflit avec ceux du lecteur.
 *
 * Pleine largeur sans marge haute pour l'accueil et les fiches : leur image de
 * fond passe SOUS la barre de navigation, c'est ce qui donne l'ampleur.
 *
 * Pleine largeur sous la barre pour les bibliothèques et la recherche : la
 * grille court d'un bord à l'autre comme sur Disney+, et pose elle-même sa
 * marge latérale de 64px.
 *
 * Largeur de lecture pour le reste — review, genres — où une ligne de texte qui
 * traverse un écran de 2560px devient illisible.
 */
export function App() {
  const onWatchPage = useLocation().pathname.startsWith('/watch/');

  return (
    <div className="min-h-screen">
      {!onWatchPage && <TopNav />}
      <Routes>
        <Route path="/watch/:mediaFileId" element={<WatchPage />} />
        <Route path="/" element={<HomePage />} />
        <Route path="/movie/:id" element={<MoviePage />} />
        <Route path="/show/:id" element={<ShowPage />} />

        <Route
          path="/library/:libraryId"
          element={
            <main className="pt-[68px]">
              <LibraryPage />
            </main>
          }
        />
        <Route
          path="/search"
          element={
            <main className="pt-[68px]">
              <SearchPage />
            </main>
          }
        />

        <Route path="*" element={<ReadableLayout />} />
      </Routes>
    </div>
  );
}

function ReadableLayout() {
  return (
    <main className="mx-auto max-w-7xl px-6 pt-[92px] pb-8">
      <Routes>
        <Route path="/bibliotheques" element={<Home />} />
        <Route path="/genres" element={<GenresPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/preparation" element={<PreparationPage />} />
        {/* Page de mise au point du composant vignette, retirée après validation. */}
        <Route path="/demo/vignette" element={<TileDemoPage />} />
        <Route path="*" element={<p className="py-16 text-center text-faible">Page introuvable.</p>} />
      </Routes>
    </main>
  );
}
