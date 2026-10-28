from django.core.management.base import BaseCommand

from canvas.models import Canvas


class Command(BaseCommand):
    help = "Create the initial 100x100 canvas without overwriting existing state."

    def handle(self, *args, **options):
        canvas, created = Canvas.objects.get_or_create(
            slug="main",
            defaults={"name": "Main Canvas"},
        )
        self.stdout.write(f"Canvas {canvas.pk}: {'created' if created else 'already exists'}")
