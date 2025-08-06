import { Router } from 'express';

export const Routes = Router();

Routes.get('/', (req, res) => {
  res.status(200).json({ status: 'Mitsi Signaling Running' });
});
Routes.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
