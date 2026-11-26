import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import Crew from './Crew';
const path=window.location.pathname;
createRoot(document.getElementById('root')!).render(<StrictMode>{path==='/crew'?<Crew/>:<App/>}</StrictMode>);
