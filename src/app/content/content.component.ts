import { Component, OnInit } from '@angular/core';
import { ContentService } from '../content.service';

@Component({
  selector: 'app-content',
  templateUrl: './content.component.html',
  styleUrls: ['./content.component.css']
})

export class ContentComponent implements OnInit {

  private _activeDescriptor: string;

  constructor(private _contentService: ContentService) { }

  ngOnInit() {
  	this._contentService.getActive().subscribe( newDescriptor => {
      this._activeDescriptor = newDescriptor; });
  }

  isAbout():boolean {
  	return this._activeDescriptor === 'About';
  }

  isHome():boolean {
  	return this._activeDescriptor === 'Home';
  }

  isContact():boolean {
  	return this._activeDescriptor === 'Contact Me';
  }

  isProjects():boolean {
  	return this._activeDescriptor === 'Projects';
  }

}
