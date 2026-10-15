import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/msw-server';
import { renderRoute } from '../test/render-route';

describe('routes', () => {
  it('redirects the root to the voyage list', async () => {
    server.use(http.get('*/api/voyages', () => HttpResponse.json({ items: [] })));
    const { router } = renderRoute('/');

    expect(await screen.findByRole('heading', { name: 'Voyages' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/voyages');
  });

  it('shows a not-found page for unknown paths', async () => {
    renderRoute('/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
