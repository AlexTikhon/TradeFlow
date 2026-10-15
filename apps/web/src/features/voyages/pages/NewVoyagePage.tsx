import { Breadcrumbs, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router';
import { useIdentity } from '../../../shared/auth/identity';
import { NotFoundState } from '../../../shared/ui/NotFoundState';
import { PageHeader } from '../../../shared/ui/PageHeader';
import { CreateVoyageForm } from '../components/CreateVoyageForm';
import { canCreateVoyages } from '../domain/permissions';

export function NewVoyagePage() {
  const identity = useIdentity();

  if (!canCreateVoyages(identity)) {
    return (
      <NotFoundState
        title="You cannot create voyages"
        message="Your role allows you to view your organization's voyages, but not to create them. Ask an operator in your organization."
      />
    );
  }

  return (
    <Stack spacing={3}>
      <Breadcrumbs aria-label="Breadcrumb">
        <Link component={RouterLink} to="/voyages" underline="hover" color="inherit">
          Voyages
        </Link>
        <Typography color="text.primary">New voyage</Typography>
      </Breadcrumbs>
      <div>
        <PageHeader title="New voyage" />
        <CreateVoyageForm />
      </div>
    </Stack>
  );
}
